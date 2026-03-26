require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, 'data');
const CASES_FILE    = path.join(DATA_DIR, 'cases.json');
const WARRANTS_FILE = path.join(DATA_DIR, 'warrants.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function fmtDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('[DOJ Bot] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID. Bot will not start.');
  process.exit(0);
}

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post a live case/warrant lookup embed in the designated channels')
    .addChannelOption(opt =>
      opt.setName('warrant_channel')
        .setDescription('Channel to post the active warrants lookup embed')
        .setRequired(true))
    .addChannelOption(opt =>
      opt.setName('case_channel')
        .setDescription('Channel to post the active cases lookup embed')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('case')
    .setDescription('Look up a specific case by case number')
    .addStringOption(opt =>
      opt.setName('number')
        .setDescription('Case number (e.g. DOJ-2025-0001)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('warrant')
    .setDescription('Look up a specific warrant by warrant number')
    .addStringOption(opt =>
      opt.setName('number')
        .setDescription('Warrant number (e.g. W-2025-0001)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('activecases')
    .setDescription('List all currently active cases'),

  new SlashCommandBuilder()
    .setName('activewarrants')
    .setDescription('List all currently active warrants'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show DOJ system statistics'),
].map(c => c.toJSON());

// ── Register slash commands ───────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    console.log('[DOJ Bot] Registering slash commands…');
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('[DOJ Bot] Slash commands registered.');
  } catch (err) {
    console.error('[DOJ Bot] Failed to register commands:', err);
  }
}

// ── Build warrant embed ────────────────────────────────────────────────────────
function buildWarrantEmbed(warrant) {
  const statusColor = { active: 0x22c55e, executed: 0x6b7280, expired: 0xef4444, cancelled: 0xef4444 };
  return new EmbedBuilder()
    .setTitle(`🔴 ${warrant.type.charAt(0).toUpperCase() + warrant.type.slice(1)} Warrant — ${warrant.warrantNumber}`)
    .setColor(statusColor[warrant.status] || 0x6b7280)
    .setDescription(`**Subject:** ${warrant.subject}`)
    .addFields(
      { name: 'Status',         value: warrant.status.charAt(0).toUpperCase() + warrant.status.slice(1), inline: true },
      { name: 'County',         value: warrant.county ? `${warrant.county} County, TX` : 'N/A', inline: true },
      { name: 'Issuing Judge',  value: warrant.judge || 'N/A', inline: true },
      { name: 'Issued By',      value: warrant.issuedBy || 'N/A', inline: true },
      { name: 'Issue Date',     value: fmtDate(warrant.issuedAt), inline: true },
      { name: 'Expires',        value: fmtDate(warrant.expiresAt), inline: true },
      { name: 'DOB',            value: fmtDate(warrant.subjectDob), inline: true },
      { name: 'Description',    value: warrant.subjectDescription || 'N/A', inline: true },
      { name: 'Address',        value: warrant.address || 'N/A', inline: true },
      { name: 'Probable Cause', value: (warrant.description || 'N/A').slice(0, 1024) }
    )
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Build case embed ──────────────────────────────────────────────────────────
function buildCaseEmbed(c) {
  const statusColor = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const chargesText = (c.charges || []).slice(0, 5).join('\n') || 'None listed';
  return new EmbedBuilder()
    .setTitle(`⚖️ Case ${c.caseNumber} — ${c.title}`)
    .setColor(statusColor[c.status] || 0x6b7280)
    .setDescription(`**Defendant:** ${c.subject}`)
    .addFields(
      { name: 'Status',           value: c.status.charAt(0).toUpperCase() + c.status.slice(1), inline: true },
      { name: 'Priority',         value: c.priority || 'Medium', inline: true },
      { name: 'Grade',            value: c.caseGrade || 'N/A', inline: true },
      { name: 'County',           value: c.county ? `${c.county} County, TX` : 'N/A', inline: true },
      { name: 'Court',            value: c.courtType || 'N/A', inline: true },
      { name: 'Plea',             value: c.plea || 'Not Entered', inline: true },
      { name: 'Verdict',          value: c.verdict || 'Pending', inline: true },
      { name: 'Bond / Bail',      value: c.bondAmount != null ? `$${Number(c.bondAmount).toLocaleString()}` : 'N/A', inline: true },
      { name: 'Hearing Date',     value: fmtDate(c.courtDate), inline: true },
      { name: 'Presiding Judge',  value: c.presidingJudge || 'N/A', inline: true },
      { name: 'Prosecutor',       value: c.prosecutor || 'N/A', inline: true },
      { name: 'Defense Attorney', value: c.defenseAttorney || 'N/A', inline: true },
      { name: 'Charges',          value: chargesText },
    )
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Build warrants list select menu ──────────────────────────────────────────
function buildWarrantsSelectMenu() {
  const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active').slice(0, 25);
  if (!warrants.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('warrant_lookup')
    .setPlaceholder('Select a warrant to view details…')
    .addOptions(warrants.map(w =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${w.warrantNumber} — ${w.subject}`.slice(0, 100))
        .setDescription(`${w.type.charAt(0).toUpperCase() + w.type.slice(1)} Warrant · ${w.county || ''} County`.slice(0, 100))
        .setValue(w.id)
    ));
  return new ActionRowBuilder().addComponents(menu);
}

// ── Build cases list select menu ──────────────────────────────────────────────
function buildCasesSelectMenu() {
  const cases = readJSON(CASES_FILE).filter(c => !['closed','dismissed'].includes(c.status)).slice(0, 25);
  if (!cases.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('case_lookup')
    .setPlaceholder('Select a case to view details…')
    .addOptions(cases.map(c =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${c.caseNumber} — ${c.subject}`.slice(0, 100))
        .setDescription(`${c.title}`.slice(0, 100))
        .setValue(c.id)
    ));
  return new ActionRowBuilder().addComponents(menu);
}

// ── Client setup ─────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`[DOJ Bot] Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // /setup
    if (interaction.commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });

      const warrantChannel = interaction.options.getChannel('warrant_channel');
      const caseChannel    = interaction.options.getChannel('case_channel');

      // Post to warrant channel
      const warrantRow = buildWarrantsSelectMenu();
      const warrantEmbed = new EmbedBuilder()
        .setTitle('🔴 Active Warrant Lookup')
        .setDescription('Select a warrant from the dropdown below to view its full details.\nResults are shown only to you.')
        .setColor(0xef4444)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();

      try {
        if (warrantRow) {
          await warrantChannel.send({ embeds: [warrantEmbed], components: [warrantRow] });
        } else {
          await warrantChannel.send({ embeds: [warrantEmbed.setDescription('No active warrants at this time.')] });
        }
      } catch (e) {
        await interaction.editReply({ content: `⚠️ Could not post to <#${warrantChannel.id}>. Check bot permissions.` });
        return;
      }

      // Post to case channel
      const caseRow = buildCasesSelectMenu();
      const caseEmbed = new EmbedBuilder()
        .setTitle('⚖️ Active Case Lookup')
        .setDescription('Select a case from the dropdown below to view its full details.\nResults are shown only to you.')
        .setColor(0x3b82f6)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();

      try {
        if (caseRow) {
          await caseChannel.send({ embeds: [caseEmbed], components: [caseRow] });
        } else {
          await caseChannel.send({ embeds: [caseEmbed.setDescription('No active cases at this time.')] });
        }
      } catch (e) {
        await interaction.editReply({ content: `⚠️ Could not post to <#${caseChannel.id}>. Check bot permissions.` });
        return;
      }

      await interaction.editReply({ content: `✅ Setup complete!\n• Warrant lookup posted in <#${warrantChannel.id}>\n• Case lookup posted in <#${caseChannel.id}>` });
      return;
    }

    // /case
    if (interaction.commandName === 'case') {
      await interaction.deferReply({ ephemeral: true });
      const number = interaction.options.getString('number').trim().toUpperCase();
      const cases = readJSON(CASES_FILE);
      const c = cases.find(x => (x.caseNumber||'').toUpperCase() === number);
      if (!c) {
        await interaction.editReply({ content: `❌ No case found with number **${number}**.` });
        return;
      }
      await interaction.editReply({ embeds: [buildCaseEmbed(c)] });
      return;
    }

    // /warrant
    if (interaction.commandName === 'warrant') {
      await interaction.deferReply({ ephemeral: true });
      const number = interaction.options.getString('number').trim().toUpperCase();
      const warrants = readJSON(WARRANTS_FILE);
      const w = warrants.find(x => (x.warrantNumber||'').toUpperCase() === number);
      if (!w) {
        await interaction.editReply({ content: `❌ No warrant found with number **${number}**.` });
        return;
      }
      await interaction.editReply({ embeds: [buildWarrantEmbed(w)] });
      return;
    }

    // /activecases
    if (interaction.commandName === 'activecases') {
      await interaction.deferReply({ ephemeral: true });
      const cases = readJSON(CASES_FILE).filter(c => !['closed','dismissed'].includes(c.status));
      if (!cases.length) {
        await interaction.editReply({ content: 'No active cases at this time.' });
        return;
      }
      const lines = cases.slice(0, 20).map(c =>
        `• **${c.caseNumber}** — ${c.subject} | ${c.status} | ${c.county || 'Unknown'} County`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`⚖️ Active Cases (${cases.length})`)
        .setDescription(lines)
        .setColor(0x3b82f6)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // /activewarrants
    if (interaction.commandName === 'activewarrants') {
      await interaction.deferReply({ ephemeral: true });
      const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active');
      if (!warrants.length) {
        await interaction.editReply({ content: 'No active warrants at this time.' });
        return;
      }
      const lines = warrants.slice(0, 20).map(w =>
        `• **${w.warrantNumber}** — ${w.subject} | ${w.type} | ${w.county || 'Unknown'} County`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`🔴 Active Warrants (${warrants.length})`)
        .setDescription(lines)
        .setColor(0xef4444)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // /stats
    if (interaction.commandName === 'stats') {
      await interaction.deferReply({ ephemeral: true });
      const cases    = readJSON(CASES_FILE);
      const warrants = readJSON(WARRANTS_FILE);
      const embed = new EmbedBuilder()
        .setTitle('📊 DOJ System Statistics')
        .setColor(0x111827)
        .addFields(
          { name: 'Total Cases',         value: String(cases.length), inline: true },
          { name: 'Active Cases',        value: String(cases.filter(c=>!['closed','dismissed'].includes(c.status)).length), inline: true },
          { name: 'Closed Cases',        value: String(cases.filter(c=>c.status==='closed').length), inline: true },
          { name: 'Total Warrants',      value: String(warrants.length), inline: true },
          { name: 'Active Warrants',     value: String(warrants.filter(w=>w.status==='active').length), inline: true },
          { name: 'Executed Warrants',   value: String(warrants.filter(w=>w.status==='executed').length), inline: true },
        )
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  }

  // ── Select menus ────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {

    // Warrant lookup dropdown
    if (interaction.customId === 'warrant_lookup') {
      await interaction.deferReply({ ephemeral: true });
      const warrantId = interaction.values[0];
      const warrants = readJSON(WARRANTS_FILE);
      const w = warrants.find(x => x.id === warrantId);
      if (!w) {
        await interaction.editReply({ content: '❌ Warrant not found. The data may have been updated.' });
        return;
      }
      await interaction.editReply({ embeds: [buildWarrantEmbed(w)] });
      return;
    }

    // Case lookup dropdown
    if (interaction.customId === 'case_lookup') {
      await interaction.deferReply({ ephemeral: true });
      const caseId = interaction.values[0];
      const cases = readJSON(CASES_FILE);
      const c = cases.find(x => x.id === caseId);
      if (!c) {
        await interaction.editReply({ content: '❌ Case not found. The data may have been updated.' });
        return;
      }
      await interaction.editReply({ embeds: [buildCaseEmbed(c)] });
      return;
    }
  }
});

client.login(TOKEN).catch(err => {
  console.error('[DOJ Bot] Login failed:', err.message);
  process.exit(0);
});
