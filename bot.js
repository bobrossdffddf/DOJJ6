require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Events, PermissionFlagsBits
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const DATA_DIR        = path.join(__dirname, 'data');
const CASES_FILE      = path.join(DATA_DIR, 'cases.json');
const WARRANTS_FILE   = path.join(DATA_DIR, 'warrants.json');
const SUBPOENAS_FILE  = path.join(DATA_DIR, 'subpoenas.json');
const DEFENDANTS_FILE = path.join(DATA_DIR, 'defendants.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function fmtDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function capitalize(s) {
  if (!s) return 'N/A';
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    .setDescription('Post active case/warrant lookup embeds with dropdowns to designated channels')
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
    .setName('subpoena')
    .setDescription('Look up a specific subpoena by subpoena number')
    .addStringOption(opt =>
      opt.setName('number')
        .setDescription('Subpoena number (e.g. SP-2025-0001)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('defendant')
    .setDescription('Search for a defendant record by name')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Full or partial name of the defendant')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Search all DOJ records (cases, warrants, defendants) for a person')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Full or partial name to search across all records')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('activecases')
    .setDescription('List all currently active/open cases'),

  new SlashCommandBuilder()
    .setName('activewarrants')
    .setDescription('List all currently active warrants'),

  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('List all cases currently pending trial (filed/pending status)'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show DOJ system statistics'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('List all available DOJ bot commands'),
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
function buildWarrantEmbed(w) {
  const statusColor = { active: 0x22c55e, executed: 0x6b7280, expired: 0xef4444, cancelled: 0xef4444 };
  const typeBadge   = { arrest: '🔴', search: '🔍', bench: '⚖️' };
  const icon = typeBadge[w.type] || '📋';
  return new EmbedBuilder()
    .setTitle(`${icon} ${capitalize(w.type)} Warrant — ${w.warrantNumber}`)
    .setColor(statusColor[w.status] || 0x6b7280)
    .setDescription(`**Subject:** ${w.subject}`)
    .addFields(
      { name: '📌 Status',         value: capitalize(w.status), inline: true },
      { name: '📍 County',         value: w.county ? `${w.county} County, TX` : 'N/A', inline: true },
      { name: '⚖️ Issuing Judge',  value: w.judge || 'N/A', inline: true },
      { name: '👤 Issued By',      value: w.issuedBy || 'N/A', inline: true },
      { name: '📅 Issue Date',     value: fmtDate(w.issuedAt), inline: true },
      { name: '⏳ Expires',        value: fmtDate(w.expiresAt), inline: true },
      { name: '🎂 DOB',            value: fmtDate(w.subjectDob), inline: true },
      { name: '📝 Description',    value: w.subjectDescription || 'N/A', inline: true },
      { name: '🏠 Address',        value: w.address || 'N/A', inline: true },
      { name: '📄 Probable Cause', value: (w.description || 'N/A').slice(0, 1024) }
    )
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Build case embed ──────────────────────────────────────────────────────────
function buildCaseEmbed(c) {
  const statusColor = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const chargesText = (c.charges || []).slice(0, 5).join('\n') || 'None listed';
  const fields = [
    { name: '📌 Status',           value: capitalize(c.status), inline: true },
    { name: '⚡ Priority',         value: capitalize(c.priority) || 'Medium', inline: true },
    { name: '⚖️ Grade',            value: c.caseGrade || 'N/A', inline: true },
    { name: '📍 County',           value: c.county ? `${c.county} County, TX` : 'N/A', inline: true },
    { name: '🏛️ Court',            value: c.courtType || 'N/A', inline: true },
    { name: '🗣️ Plea',             value: c.plea || 'Not Entered', inline: true },
    { name: '📜 Verdict',          value: c.verdict || 'Pending', inline: true },
    { name: '💰 Bond / Bail',      value: c.bondAmount != null && c.bondAmount !== '' ? `$${Number(c.bondAmount).toLocaleString()}` : 'N/A', inline: true },
    { name: '📅 Hearing Date',     value: fmtDate(c.courtDate), inline: true },
    { name: '👨‍⚖️ Presiding Judge',  value: c.presidingJudge || 'N/A', inline: true },
    { name: '👔 Prosecutor',       value: c.prosecutor || 'N/A', inline: true },
    { name: '🧑‍💼 Defense Counsel', value: c.defenseAttorney || 'N/A', inline: true },
    { name: '📋 Charges',          value: chargesText },
  ];
  if (c.sentence) {
    fields.push({ name: '🔒 Sentence', value: c.sentence.slice(0, 512) });
  }
  return new EmbedBuilder()
    .setTitle(`⚖️ Case ${c.caseNumber} — ${c.title}`)
    .setColor(statusColor[c.status] || 0x6b7280)
    .setDescription(`**Defendant:** ${c.subject}`)
    .addFields(...fields)
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Build subpoena embed ──────────────────────────────────────────────────────
function buildSubpoenaEmbed(s) {
  const statusColor = { pending: 0xeab308, served: 0x22c55e, failed: 0xef4444, quashed: 0x6b7280 };
  return new EmbedBuilder()
    .setTitle(`📜 Subpoena — ${s.subpoenaNumber}`)
    .setColor(statusColor[s.status] || 0x6b7280)
    .setDescription(`**Recipient:** ${s.recipient}`)
    .addFields(
      { name: '📌 Status',    value: capitalize(s.status), inline: true },
      { name: '📋 Type',      value: capitalize(s.type || 'testimony'), inline: true },
      { name: '📅 Due Date',  value: fmtDate(s.dueDate), inline: true },
      { name: '👤 Issued By', value: s.issuedBy || 'N/A', inline: true },
      { name: '📅 Issued',    value: fmtDate(s.issuedAt), inline: true },
      { name: '🔗 Linked Case', value: s.linkedCaseId ? `See portal` : 'N/A', inline: true },
      { name: '📄 Purpose',   value: (s.purpose || 'N/A').slice(0, 1024) }
    )
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Build defendant embed ─────────────────────────────────────────────────────
function buildDefendantEmbed(d, cases, warrants) {
  const linkedCases    = cases.filter(c => c.subject && c.subject.toLowerCase() === d.fullName.toLowerCase());
  const linkedWarrants = warrants.filter(w => w.subject && w.subject.toLowerCase() === d.fullName.toLowerCase());
  const embed = new EmbedBuilder()
    .setTitle(`👤 Defendant Record — ${d.fullName}`)
    .setColor(0x111827)
    .addFields(
      { name: '🎂 Date of Birth',    value: fmtDate(d.dob), inline: true },
      { name: '🪪 TX DL / ID #',     value: d.id_number || 'N/A', inline: true },
      { name: '📍 County',           value: d.county ? `${d.county} County, TX` : 'N/A', inline: true },
      { name: '📏 Height / Weight',  value: `${d.height || 'N/A'} / ${d.weight || 'N/A'}`, inline: true },
      { name: '🎨 Hair / Eyes',      value: `${d.hair || 'N/A'} / ${d.eyes || 'N/A'}`, inline: true },
      { name: '📞 Phone',            value: d.phone || 'N/A', inline: true },
      { name: '🏠 Address',          value: [d.address, d.city].filter(Boolean).join(', ') || 'N/A', inline: false },
      { name: `⚖️ Cases (${linkedCases.length})`,
        value: linkedCases.slice(0, 5).map(c => `• ${c.caseNumber} — ${c.title} [${c.status}]`).join('\n') || 'None on record',
        inline: false },
      { name: `🔴 Warrants (${linkedWarrants.length})`,
        value: linkedWarrants.slice(0, 5).map(w => `• ${w.warrantNumber} — ${capitalize(w.type)} [${w.status}]`).join('\n') || 'None on record',
        inline: false },
    )
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
  if (d.notes) embed.addFields({ name: '📝 Notes', value: d.notes.slice(0, 512) });
  return embed;
}

// ── Build warrants select menu ────────────────────────────────────────────────
function buildWarrantsSelectMenu() {
  const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active').slice(0, 25);
  if (!warrants.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('warrant_lookup')
    .setPlaceholder('Select a warrant to view its full details…')
    .addOptions(warrants.map(w =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${w.warrantNumber} — ${w.subject}`.slice(0, 100))
        .setDescription(`${capitalize(w.type)} Warrant · ${w.county || 'Unknown'} County, TX`.slice(0, 100))
        .setValue(w.id)
    ));
  return new ActionRowBuilder().addComponents(menu);
}

// ── Build cases select menu ───────────────────────────────────────────────────
function buildCasesSelectMenu() {
  const cases = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status)).slice(0, 25);
  if (!cases.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('case_lookup')
    .setPlaceholder('Select a case to view its full details…')
    .addOptions(cases.map(c =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${c.caseNumber} — ${c.subject}`.slice(0, 100))
        .setDescription(`${c.title} · ${capitalize(c.status)}`.slice(0, 100))
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

    // ── /setup ──────────────────────────────────────────────────────────────
    if (interaction.commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });

      const warrantChannel = interaction.options.getChannel('warrant_channel');
      const caseChannel    = interaction.options.getChannel('case_channel');

      // Warrant channel
      const warrantRow   = buildWarrantsSelectMenu();
      const warrantEmbed = new EmbedBuilder()
        .setTitle('🔴 Active Warrant Lookup')
        .setDescription(
          'Use the dropdown below to select an active warrant and view its full details.\n' +
          '> Results are shown **only to you** (ephemeral).\n\n' +
          `**Active Warrants:** ${readJSON(WARRANTS_FILE).filter(w => w.status === 'active').length}`
        )
        .setColor(0xef4444)
        .setFooter({ text: 'State of Texas — Department of Justice • Authorized Personnel Only' })
        .setTimestamp();

      try {
        if (warrantRow) {
          await warrantChannel.send({ embeds: [warrantEmbed], components: [warrantRow] });
        } else {
          await warrantChannel.send({ embeds: [warrantEmbed.setDescription('No active warrants at this time.')] });
        }
      } catch {
        return interaction.editReply({ content: `⚠️ Could not post to <#${warrantChannel.id}>. Check bot permissions.` });
      }

      // Case channel
      const caseRow   = buildCasesSelectMenu();
      const caseEmbed = new EmbedBuilder()
        .setTitle('⚖️ Active Case Lookup')
        .setDescription(
          'Use the dropdown below to select an active case and view its full details.\n' +
          '> Results are shown **only to you** (ephemeral).\n\n' +
          `**Active Cases:** ${readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status)).length}`
        )
        .setColor(0x3b82f6)
        .setFooter({ text: 'State of Texas — Department of Justice • Authorized Personnel Only' })
        .setTimestamp();

      try {
        if (caseRow) {
          await caseChannel.send({ embeds: [caseEmbed], components: [caseRow] });
        } else {
          await caseChannel.send({ embeds: [caseEmbed.setDescription('No active cases at this time.')] });
        }
      } catch {
        return interaction.editReply({ content: `⚠️ Could not post to <#${caseChannel.id}>. Check bot permissions.` });
      }

      await interaction.editReply({
        content: `✅ **Setup complete!**\n• Warrant lookup posted in <#${warrantChannel.id}>\n• Case lookup posted in <#${caseChannel.id}>`
      });
      return;
    }

    // ── /case ────────────────────────────────────────────────────────────────
    if (interaction.commandName === 'case') {
      await interaction.deferReply({ ephemeral: true });
      const number = interaction.options.getString('number').trim().toUpperCase();
      const c = readJSON(CASES_FILE).find(x => (x.caseNumber || '').toUpperCase() === number);
      if (!c) return interaction.editReply({ content: `❌ No case found with number **${number}**.` });
      return interaction.editReply({ embeds: [buildCaseEmbed(c)] });
    }

    // ── /warrant ─────────────────────────────────────────────────────────────
    if (interaction.commandName === 'warrant') {
      await interaction.deferReply({ ephemeral: true });
      const number = interaction.options.getString('number').trim().toUpperCase();
      const w = readJSON(WARRANTS_FILE).find(x => (x.warrantNumber || '').toUpperCase() === number);
      if (!w) return interaction.editReply({ content: `❌ No warrant found with number **${number}**.` });
      return interaction.editReply({ embeds: [buildWarrantEmbed(w)] });
    }

    // ── /subpoena ────────────────────────────────────────────────────────────
    if (interaction.commandName === 'subpoena') {
      await interaction.deferReply({ ephemeral: true });
      const number = interaction.options.getString('number').trim().toUpperCase();
      const s = readJSON(SUBPOENAS_FILE).find(x => (x.subpoenaNumber || '').toUpperCase() === number);
      if (!s) return interaction.editReply({ content: `❌ No subpoena found with number **${number}**.` });
      return interaction.editReply({ embeds: [buildSubpoenaEmbed(s)] });
    }

    // ── /defendant ───────────────────────────────────────────────────────────
    if (interaction.commandName === 'defendant') {
      await interaction.deferReply({ ephemeral: true });
      const name  = interaction.options.getString('name').trim().toLowerCase();
      const defendants = readJSON(DEFENDANTS_FILE);
      const matches = defendants.filter(d => d.fullName.toLowerCase().includes(name));

      if (!matches.length) {
        return interaction.editReply({ content: `❌ No defendant records found matching **"${interaction.options.getString('name')}"**.` });
      }
      if (matches.length === 1) {
        const cases    = readJSON(CASES_FILE);
        const warrants = readJSON(WARRANTS_FILE);
        return interaction.editReply({ embeds: [buildDefendantEmbed(matches[0], cases, warrants)] });
      }

      // Multiple matches — list them
      const lines = matches.slice(0, 15).map(d =>
        `• **${d.fullName}** — DOB: ${fmtDate(d.dob)} | ${d.county ? d.county + ' County' : 'County N/A'}`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`👤 Defendant Search — ${matches.length} match(es)`)
        .setDescription(`Showing up to 15 results for **"${interaction.options.getString('name')}"**:\n\n${lines}`)
        .setColor(0x111827)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /lookup ──────────────────────────────────────────────────────────────
    if (interaction.commandName === 'lookup') {
      await interaction.deferReply({ ephemeral: true });
      const name     = interaction.options.getString('name').trim().toLowerCase();
      const rawName  = interaction.options.getString('name').trim();
      const cases    = readJSON(CASES_FILE).filter(c => (c.subject || '').toLowerCase().includes(name));
      const warrants = readJSON(WARRANTS_FILE).filter(w => (w.subject || '').toLowerCase().includes(name));
      const defs     = readJSON(DEFENDANTS_FILE).filter(d => (d.fullName || '').toLowerCase().includes(name));

      if (!cases.length && !warrants.length && !defs.length) {
        return interaction.editReply({ content: `❌ No records found for **"${rawName}"** across cases, warrants, or defendants.` });
      }

      const embed = new EmbedBuilder()
        .setTitle(`🔎 Full Record Search — "${rawName}"`)
        .setColor(0x111827)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();

      if (defs.length) {
        embed.addFields({
          name: `👤 Defendant Records (${defs.length})`,
          value: defs.slice(0, 5).map(d =>
            `• **${d.fullName}** | DOB: ${fmtDate(d.dob)} | ${d.county ? d.county + ' County' : 'N/A'}`
          ).join('\n')
        });
      }

      if (cases.length) {
        embed.addFields({
          name: `⚖️ Cases (${cases.length})`,
          value: cases.slice(0, 5).map(c =>
            `• **${c.caseNumber}** — ${c.title} | ${capitalize(c.status)} | ${c.county ? c.county + ' County' : 'N/A'}`
          ).join('\n')
        });
      }

      if (warrants.length) {
        embed.addFields({
          name: `🔴 Warrants (${warrants.length})`,
          value: warrants.slice(0, 5).map(w =>
            `• **${w.warrantNumber}** — ${capitalize(w.type)} | ${capitalize(w.status)} | ${w.county ? w.county + ' County' : 'N/A'}`
          ).join('\n')
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /activecases ─────────────────────────────────────────────────────────
    if (interaction.commandName === 'activecases') {
      await interaction.deferReply({ ephemeral: true });
      const cases = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status));
      if (!cases.length) return interaction.editReply({ content: 'No active cases at this time.' });

      const lines = cases.slice(0, 20).map(c =>
        `• **${c.caseNumber}** — ${c.subject} | ${capitalize(c.status)} | ${c.county || 'Unknown'} County`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`⚖️ Active Cases (${cases.length})`)
        .setDescription(lines + (cases.length > 20 ? `\n*…and ${cases.length - 20} more*` : ''))
        .setColor(0x3b82f6)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /activewarrants ───────────────────────────────────────────────────────
    if (interaction.commandName === 'activewarrants') {
      await interaction.deferReply({ ephemeral: true });
      const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active');
      if (!warrants.length) return interaction.editReply({ content: 'No active warrants at this time.' });

      const lines = warrants.slice(0, 20).map(w =>
        `• **${w.warrantNumber}** — ${w.subject} | ${capitalize(w.type)} | ${w.county || 'Unknown'} County`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`🔴 Active Warrants (${warrants.length})`)
        .setDescription(lines + (warrants.length > 20 ? `\n*…and ${warrants.length - 20} more*` : ''))
        .setColor(0xef4444)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /pending ─────────────────────────────────────────────────────────────
    if (interaction.commandName === 'pending') {
      await interaction.deferReply({ ephemeral: true });
      const cases = readJSON(CASES_FILE).filter(c => ['pending', 'filed'].includes(c.status));
      if (!cases.length) return interaction.editReply({ content: 'No cases currently pending trial.' });

      const lines = cases.slice(0, 20).map(c =>
        `• **${c.caseNumber}** — ${c.subject} | ${capitalize(c.status)} | Hearing: ${fmtDate(c.courtDate)} | ${c.county ? c.county + ' County' : 'N/A'}`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`⏳ Cases Pending Trial (${cases.length})`)
        .setDescription(lines + (cases.length > 20 ? `\n*…and ${cases.length - 20} more*` : ''))
        .setColor(0xeab308)
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /stats ────────────────────────────────────────────────────────────────
    if (interaction.commandName === 'stats') {
      await interaction.deferReply({ ephemeral: true });
      const cases    = readJSON(CASES_FILE);
      const warrants = readJSON(WARRANTS_FILE);
      const defs     = readJSON(DEFENDANTS_FILE);
      const subps    = readJSON(SUBPOENAS_FILE);

      const activeCases    = cases.filter(c => !['closed', 'dismissed'].includes(c.status)).length;
      const pendingCases   = cases.filter(c => ['pending', 'filed'].includes(c.status)).length;
      const closedCases    = cases.filter(c => c.status === 'closed').length;
      const activeWarrants = warrants.filter(w => w.status === 'active').length;
      const execWarrants   = warrants.filter(w => w.status === 'executed').length;
      const pendingSubs    = subps.filter(s => s.status === 'pending').length;

      const embed = new EmbedBuilder()
        .setTitle('📊 DOJ System Statistics')
        .setColor(0x111827)
        .addFields(
          { name: '📁 Total Cases',        value: String(cases.length), inline: true },
          { name: '✅ Active Cases',        value: String(activeCases), inline: true },
          { name: '⏳ Pending Trial',       value: String(pendingCases), inline: true },
          { name: '🔒 Closed Cases',        value: String(closedCases), inline: true },
          { name: '🚫 Dismissed',           value: String(cases.filter(c => c.status === 'dismissed').length), inline: true },
          { name: '\u200b',                value: '\u200b', inline: true },
          { name: '📋 Total Warrants',      value: String(warrants.length), inline: true },
          { name: '🔴 Active Warrants',     value: String(activeWarrants), inline: true },
          { name: '✔️ Executed Warrants',   value: String(execWarrants), inline: true },
          { name: '👤 Defendant Records',   value: String(defs.length), inline: true },
          { name: '📜 Subpoenas',           value: String(subps.length), inline: true },
          { name: '⌛ Pending Subpoenas',   value: String(pendingSubs), inline: true },
        )
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    if (interaction.commandName === 'help') {
      await interaction.deferReply({ ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('📖 DOJ Bot — Command Reference')
        .setColor(0x111827)
        .setDescription('All commands return results only to you (ephemeral).')
        .addFields(
          {
            name: '⚙️ Setup',
            value: '`/setup [warrant_channel] [case_channel]` — Post live lookup embeds with dropdowns to designated channels'
          },
          {
            name: '🔍 Lookup by Number',
            value: [
              '`/case [number]` — Look up a case by number (e.g. DOJ-2025-0001)',
              '`/warrant [number]` — Look up a warrant by number (e.g. W-2025-0001)',
              '`/subpoena [number]` — Look up a subpoena by number (e.g. SP-2025-0001)',
            ].join('\n')
          },
          {
            name: '👤 Person Search',
            value: [
              '`/defendant [name]` — Search defendant records by name',
              '`/lookup [name]` — Search all records (cases, warrants, defendants) for a person',
            ].join('\n')
          },
          {
            name: '📋 Lists',
            value: [
              '`/activecases` — List all active/open cases',
              '`/activewarrants` — List all active warrants',
              '`/pending` — List cases pending trial (filed/pending status)',
              '`/stats` — Show full system statistics',
            ].join('\n')
          }
        )
        .setFooter({ text: 'State of Texas — Department of Justice' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
  }

  // ── Select menus (dropdown interactions) ────────────────────────────────────
  if (interaction.isStringSelectMenu()) {

    if (interaction.customId === 'warrant_lookup') {
      await interaction.deferReply({ ephemeral: true });
      const w = readJSON(WARRANTS_FILE).find(x => x.id === interaction.values[0]);
      if (!w) return interaction.editReply({ content: '❌ Warrant not found. The data may have been updated.' });
      return interaction.editReply({ embeds: [buildWarrantEmbed(w)] });
    }

    if (interaction.customId === 'case_lookup') {
      await interaction.deferReply({ ephemeral: true });
      const c = readJSON(CASES_FILE).find(x => x.id === interaction.values[0]);
      if (!c) return interaction.editReply({ content: '❌ Case not found. The data may have been updated.' });
      return interaction.editReply({ embeds: [buildCaseEmbed(c)] });
    }
  }
});

client.login(TOKEN).catch(err => {
  console.error('[DOJ Bot] Login failed:', err.message);
  process.exit(0);
});
