require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Events
} = require('discord.js');
const fs   = require('fs');
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
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'N/A'; }

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.warn('[DOJ Bot] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID — bot will not start.');
  module.exports = null;
  return;
}

// ── Only command: /setup ──────────────────────────────────────────────────────
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
        .setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('[DOJ Bot] /setup command registered.');
  } catch (err) {
    console.error('[DOJ Bot] Failed to register commands:', err.message);
  }
}

// ── Embed builders ────────────────────────────────────────────────────────────
function buildWarrantEmbed(w) {
  const color = { active: 0x22c55e, executed: 0x6b7280, expired: 0xef4444, cancelled: 0xef4444 };
  return new EmbedBuilder()
    .setTitle(`${w.type === 'search' ? '🔍' : w.type === 'bench' ? '⚖️' : '🔴'} ${cap(w.type)} Warrant — ${w.warrantNumber}`)
    .setColor(color[w.status] || 0x6b7280)
    .setDescription(`**Subject:** ${w.subject}`)
    .addFields(
      { name: '📌 Status',         value: cap(w.status), inline: true },
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

function buildCaseEmbed(c) {
  const color = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const chargesText = (c.charges || []).slice(0, 5).join('\n') || 'None listed';
  const fields = [
    { name: '📌 Status',           value: cap(c.status), inline: true },
    { name: '⚡ Priority',         value: cap(c.priority) || 'Medium', inline: true },
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
  if (c.sentence) fields.push({ name: '🔒 Sentence', value: c.sentence.slice(0, 512) });
  return new EmbedBuilder()
    .setTitle(`⚖️ Case ${c.caseNumber} — ${c.title}`)
    .setColor(color[c.status] || 0x6b7280)
    .setDescription(`**Defendant:** ${c.subject}`)
    .addFields(...fields)
    .setFooter({ text: 'State of Texas — Department of Justice' })
    .setTimestamp();
}

// ── Select menu builders ──────────────────────────────────────────────────────
function buildWarrantsMenu() {
  const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active').slice(0, 25);
  if (!warrants.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('warrant_lookup')
      .setPlaceholder('Select a warrant to view its full details…')
      .addOptions(warrants.map(w =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${w.warrantNumber} — ${w.subject}`.slice(0, 100))
          .setDescription(`${cap(w.type)} Warrant · ${w.county || 'Unknown'} County, TX`.slice(0, 100))
          .setValue(w.id)
      ))
  );
}

function buildCasesMenu() {
  const cases = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status)).slice(0, 25);
  if (!cases.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('case_lookup')
      .setPlaceholder('Select a case to view its full details…')
      .addOptions(cases.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${c.caseNumber} — ${c.subject}`.slice(0, 100))
          .setDescription(`${c.title} · ${cap(c.status)}`.slice(0, 100))
          .setValue(c.id)
      ))
  );
}

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`[DOJ Bot] Online as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    await interaction.deferReply({ ephemeral: true });

    const warrantChannel = interaction.options.getChannel('warrant_channel');
    const caseChannel    = interaction.options.getChannel('case_channel');

    const activeWarrantCount = readJSON(WARRANTS_FILE).filter(w => w.status === 'active').length;
    const activeCaseCount    = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status)).length;

    // Post warrant embed
    const warrantRow = buildWarrantsMenu();
    const warrantEmbed = new EmbedBuilder()
      .setTitle('🔴 Active Warrant Lookup')
      .setDescription(
        'Select a warrant from the dropdown to view its full details.\n' +
        '> Results are shown **only to you**.\n\n' +
        `**Active Warrants on File:** ${activeWarrantCount}`
      )
      .setColor(0xef4444)
      .setFooter({ text: 'State of Texas — Department of Justice • Authorized Personnel Only' })
      .setTimestamp();

    try {
      await warrantChannel.send({
        embeds: [warrantEmbed],
        components: warrantRow ? [warrantRow] : []
      });
    } catch {
      return interaction.editReply({ content: `⚠️ Could not post to <#${warrantChannel.id}>. Check bot permissions.` });
    }

    // Post case embed
    const caseRow = buildCasesMenu();
    const caseEmbed = new EmbedBuilder()
      .setTitle('⚖️ Active Case Lookup')
      .setDescription(
        'Select a case from the dropdown to view its full details.\n' +
        '> Results are shown **only to you**.\n\n' +
        `**Active Cases on File:** ${activeCaseCount}`
      )
      .setColor(0x3b82f6)
      .setFooter({ text: 'State of Texas — Department of Justice • Authorized Personnel Only' })
      .setTimestamp();

    try {
      await caseChannel.send({
        embeds: [caseEmbed],
        components: caseRow ? [caseRow] : []
      });
    } catch {
      return interaction.editReply({ content: `⚠️ Could not post to <#${caseChannel.id}>. Check bot permissions.` });
    }

    return interaction.editReply({
      content:
        `✅ **Setup complete!**\n` +
        `• Warrant lookup posted in <#${warrantChannel.id}>\n` +
        `• Case lookup posted in <#${caseChannel.id}>`
    });
  }

  // Warrant dropdown selection
  if (interaction.isStringSelectMenu() && interaction.customId === 'warrant_lookup') {
    await interaction.deferReply({ ephemeral: true });
    const w = readJSON(WARRANTS_FILE).find(x => x.id === interaction.values[0]);
    if (!w) return interaction.editReply({ content: '❌ Warrant not found. The list may have been updated.' });
    return interaction.editReply({ embeds: [buildWarrantEmbed(w)] });
  }

  // Case dropdown selection
  if (interaction.isStringSelectMenu() && interaction.customId === 'case_lookup') {
    await interaction.deferReply({ ephemeral: true });
    const c = readJSON(CASES_FILE).find(x => x.id === interaction.values[0]);
    if (!c) return interaction.editReply({ content: '❌ Case not found. The list may have been updated.' });
    return interaction.editReply({ embeds: [buildCaseEmbed(c)] });
  }
});

client.login(TOKEN).catch(err => {
  console.error('[DOJ Bot] Login failed:', err.message);
});
