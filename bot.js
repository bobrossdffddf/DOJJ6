require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  AttachmentBuilder, Events, MessageFlags, ChannelType
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const OWNER_ID = '848356730256883744';

const DOJ_LOGO = 'https://cdn.discordapp.com/emojis/1481046563877814445.png';

const DATA_DIR           = path.join(__dirname, 'data');
const CASES_FILE         = path.join(DATA_DIR, 'cases.json');
const WARRANTS_FILE      = path.join(DATA_DIR, 'warrants.json');
const DEFENDANTS_FILE    = path.join(DATA_DIR, 'defendants.json');
const BOT_CONFIG_FILE    = path.join(DATA_DIR, 'bot_config.json');
const WARRANT_PDFS_DIR   = path.join(DATA_DIR, 'uploads', 'warrant-pdfs');
const WARRANT_REQ_DIR    = path.join(DATA_DIR, 'uploads', 'warrant-requests');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(data) {
  fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(data, null, 2));
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmtDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'N/A'; }

// ── Exhibit letter generator (A, B … Z, AA, AB …) ────────────────────────────
function toExhibitLetter(n) {
  let result = '';
  let num = n + 1;
  while (num > 0) {
    num--;
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

// ── Role check for /link and /unlink ─────────────────────────────────────────
const LINK_ALLOWED_KEYWORDS = [
  'clerk', 'paralegal', 'secretary', 'filing', 'registrar', 'notary',
  'admin assistant', 'legal assistant', 'law clerk', 'court clerk',
  'lawyer', 'attorney', 'ada', 'prosecutor', 'district attorney',
  'judge', 'justice', 'counsel', 'solicitor', 'defender', 'barrister',
  'dda', 'assistant da', 'attorney general', 'ag', 'chief justice',
  'chief', 'director', 'superintendent', 'administrator', 'hr'
];

function canLinkCase(member) {
  if (!member) return false;
  const roleNames = member.roles.cache.map(r => r.name.toLowerCase());
  return roleNames.some(n => LINK_ALLOWED_KEYWORDS.some(k => n.includes(k)));
}

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.warn('[DOJ Bot] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID — bot will not start.');
  module.exports = { refreshEmbeds: async () => {}, notifyCaseUpdate: async () => {} };
  return;
}

// ── Slash commands ─────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post active warrant and case lookup embeds to designated channels')
    .addChannelOption(opt =>
      opt.setName('warrant_channel')
        .setDescription('Channel for the active warrants lookup embed')
        .setRequired(true))
    .addChannelOption(opt =>
      opt.setName('case_channel')
        .setDescription('Channel for the active cases lookup embed')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link a DOJ Portal case to this channel and create Discovery and Documents threads')
    .addStringOption(opt =>
      opt.setName('case_number')
        .setDescription('Case number from the DOJ Portal (e.g. DOJ-2026-0001)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink a DOJ Portal case and archive its Discord threads')
    .addStringOption(opt =>
      opt.setName('case_number')
        .setDescription('Case number to unlink')
        .setRequired(true))

].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('[DOJ Bot] Commands registered (/setup, /link, /unlink).');
  } catch (err) {
    console.error('[DOJ Bot] Failed to register commands:', err.message);
  }
}

// ── Embed builders ────────────────────────────────────────────────────────────
function buildWarrantEmbed(w) {
  const color = { active: 0x22c55e, executed: 0x6b7280, expired: 0xef4444, cancelled: 0xef4444 };
  return new EmbedBuilder()
    .setTitle(`${cap(w.type)} Warrant — ${w.warrantNumber}`)
    .setColor(color[w.status] || 0x6b7280)
    .setThumbnail(DOJ_LOGO)
    .setDescription(
      `**Subject:** ${w.subject}\n` +
      `**Status:** ${cap(w.status)}  |  **Type:** ${cap(w.type)} Warrant`
    )
    .addFields(
      { name: 'County',               value: w.county ? `${w.county} County, TX` : 'N/A', inline: true },
      { name: 'Issuing Judge',        value: w.judge || 'N/A',                             inline: true },
      { name: 'Issued By',            value: w.issuedBy || 'N/A',                          inline: true },
      { name: 'Issue Date',           value: fmtDate(w.issuedAt),                          inline: true },
      { name: 'Expires',              value: fmtDate(w.expiresAt),                         inline: true },
      { name: 'Subject DOB',          value: fmtDate(w.subjectDob),                        inline: true },
      { name: 'Last Known Address',   value: w.address || 'N/A',                           inline: false },
      { name: 'Physical Description', value: w.subjectDescription || 'N/A',                inline: false },
      { name: 'Probable Cause',       value: (w.description || 'N/A').slice(0, 1024),      inline: false }
    )
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

function buildCaseEmbed(c) {
  const color = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const chargesText = (c.charges || []).slice(0, 6).map(ch => `- ${ch}`).join('\n') || 'None listed';
  const bond = c.bondAmount != null && c.bondAmount !== '' ? `$${Number(c.bondAmount).toLocaleString()}` : 'N/A';
  const fields = [
    { name: 'Status',          value: cap(c.status),                                inline: true },
    { name: 'Priority',        value: cap(c.priority) || 'Medium',                  inline: true },
    { name: 'Grade',           value: c.caseGrade || 'N/A',                         inline: true },
    { name: 'County',          value: c.county ? `${c.county} County, TX` : 'N/A', inline: true },
    { name: 'Court',           value: c.courtType || 'N/A',                         inline: true },
    { name: 'Plea',            value: cap(c.plea) || 'Not Entered',                 inline: true },
    { name: 'Verdict',         value: cap(c.verdict) || 'Pending',                  inline: true },
    { name: 'Bond / Bail',     value: bond,                                          inline: true },
    { name: 'Hearing Date',    value: fmtDate(c.courtDate),                          inline: true },
    { name: 'Presiding Judge', value: c.presidingJudge || 'N/A',                    inline: true },
    { name: 'Prosecutor',      value: c.prosecutor || 'N/A',                         inline: true },
    { name: 'Defense Counsel', value: c.defenseAttorney || 'N/A',                   inline: true },
    { name: 'Lead Officer',    value: c.assignedOfficer || 'N/A',                   inline: true },
    { name: 'Charges Filed',   value: chargesText.slice(0, 1024) },
  ];
  if (c.sentence) fields.push({ name: 'Sentence', value: c.sentence.slice(0, 512) });
  return new EmbedBuilder()
    .setTitle(`Case ${c.caseNumber} — ${c.title}`)
    .setColor(color[c.status] || 0x6b7280)
    .setThumbnail(DOJ_LOGO)
    .setDescription(`**Defendant:** ${c.subject}\n**Case Type:** ${cap(c.type || 'Criminal')}`)
    .addFields(...fields)
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

// ── Discord-link embed builders ───────────────────────────────────────────────
function buildCaseLinkAnnouncementEmbed(c, linkedBy) {
  const color = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const chargesText = (c.charges || []).slice(0, 5).map(ch => `- ${ch}`).join('\n') || 'None listed';
  return new EmbedBuilder()
    .setTitle(`Case Linked — ${c.caseNumber}`)
    .setColor(color[c.status] || 0x3b82f6)
    .setThumbnail(DOJ_LOGO)
    .setDescription(
      `**${c.title}** has been linked to Discord.\n\n` +
      `Discovery and Documents threads have been created in this channel. ` +
      `Any file submitted to the Discovery thread will be automatically cataloged as a numbered exhibit and recorded on the DOJ Portal.`
    )
    .addFields(
      { name: 'Case Number', value: c.caseNumber,               inline: true },
      { name: 'Status',      value: cap(c.status),              inline: true },
      { name: 'Type',        value: cap(c.type || 'Criminal'),  inline: true },
      { name: 'Defendant',   value: c.subject || 'N/A',         inline: true },
      { name: 'Prosecutor',  value: c.prosecutor || 'N/A',      inline: true },
      { name: 'Defense',     value: c.defenseAttorney || 'N/A', inline: true },
      { name: 'Linked By',   value: linkedBy,                   inline: true },
      { name: 'Charges',     value: chargesText.slice(0, 1024) }
    )
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

function buildExhibitRegistryEmbed(c) {
  const exhibits = c.exhibits || [];
  const statusLabel = { admitted: '[ADMITTED]', rejected: '[REJECTED]', pending: '[PENDING]' };
  const lines = exhibits.map(e =>
    `**Exhibit ${e.letter}** ${statusLabel[e.status] || '[PENDING]'} — \`${e.filename}\` — ${e.addedBy}`
  );
  return new EmbedBuilder()
    .setTitle(`Exhibit Registry — ${c.caseNumber}`)
    .setColor(0x7c3aed)
    .setThumbnail(DOJ_LOGO)
    .setDescription(
      exhibits.length
        ? lines.join('\n').slice(0, 4000)
        : 'No exhibits on file.\n\nSubmit any file to this thread to catalog it as Exhibit A.'
    )
    .setFooter({ text: 'State of Texas — Department of Justice  |  Updates automatically with each new exhibit', iconURL: DOJ_LOGO })
    .setTimestamp();
}

function buildCaseStatusUpdateEmbed(c, updatedBy) {
  const color = { open: 0x22c55e, investigation: 0x3b82f6, pending: 0xeab308, filed: 0x7c3aed, closed: 0x6b7280, dismissed: 0xef4444 };
  const fields = [
    { name: 'Status',  value: cap(c.status),               inline: true },
    { name: 'Plea',    value: cap(c.plea || 'not entered'), inline: true },
    { name: 'Verdict', value: cap(c.verdict || 'pending'),  inline: true },
  ];
  if (c.sentence)  fields.push({ name: 'Sentence',     value: c.sentence,        inline: false });
  if (c.courtDate) fields.push({ name: 'Hearing Date', value: fmtDate(c.courtDate), inline: true });
  fields.push({ name: 'Updated By', value: updatedBy || 'Portal Staff', inline: true });
  return new EmbedBuilder()
    .setTitle(`Case Updated — ${c.caseNumber}`)
    .setColor(color[c.status] || 0x6b7280)
    .setThumbnail(DOJ_LOGO)
    .setDescription(`**${c.title}** has been updated on the DOJ Portal.`)
    .addFields(...fields)
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

// ── Dropdown menu builders ────────────────────────────────────────────────────
function buildWarrantsMenu() {
  const warrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active').slice(0, 25);
  if (!warrants.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('warrant_lookup')
      .setPlaceholder('Select a warrant to view details...')
      .addOptions(warrants.map(w =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${w.warrantNumber} — ${w.subject}`.slice(0, 100))
          .setDescription(`${cap(w.type)} Warrant — ${w.county || 'Unknown'} County, TX`.slice(0, 100))
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
      .setPlaceholder('Select a case to view details...')
      .addOptions(cases.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${c.caseNumber} — ${c.subject}`.slice(0, 100))
          .setDescription(`${c.title} — ${cap(c.status)}`.slice(0, 100))
          .setValue(c.id)
      ))
  );
}

function buildWarrantHeaderEmbed(count) {
  return new EmbedBuilder()
    .setTitle('Active Warrant Lookup')
    .setThumbnail(DOJ_LOGO)
    .setDescription(
      count > 0
        ? `Select a warrant from the dropdown below to view its full details.\nResults are shown only to you.\n\n**Active Warrants on File:** ${count}`
        : 'No active warrants on file at this time.'
    )
    .setColor(0xef4444)
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

function buildCaseHeaderEmbed(count) {
  return new EmbedBuilder()
    .setTitle('Active Case Lookup')
    .setThumbnail(DOJ_LOGO)
    .setDescription(
      count > 0
        ? `Select a case from the dropdown below to view its full details.\nResults are shown only to you.\n\n**Active Cases on File:** ${count}`
        : 'No active cases on file at this time.'
    )
    .setColor(0x3b82f6)
    .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
    .setTimestamp();
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});
let ready = false;

// ── Auto-sync guild members → defendant records ───────────────────────────────
async function syncGuildMembers() {
  if (!GUILD_ID) return 0;
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    const defendants   = readJSON(DEFENDANTS_FILE);
    const existingNames = new Set(defendants.map(d => (d.fullName || '').toLowerCase()));
    let added = 0;
    for (const [, m] of members) {
      if (m.user.bot) continue;
      const name = m.nickname || m.user.globalName || m.user.username;
      if (!name || existingNames.has(name.toLowerCase())) continue;
      defendants.unshift({
        id: newId(), fullName: name, dob: '', race: '', sex: '',
        address: '', notes: `Auto-created from Discord: ${m.user.tag}`,
        linkedCases: [], linkedWarrants: [],
        discordId: m.user.id, createdAt: new Date().toISOString()
      });
      existingNames.add(name.toLowerCase());
      added++;
    }
    if (added > 0) writeJSON(DEFENDANTS_FILE, defendants);
    console.log(`[DOJ Bot] syncGuildMembers: ${added} new record(s) added.`);
    return added;
  } catch (err) {
    console.error('[DOJ Bot] syncGuildMembers error:', err.message);
    return 0;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`[DOJ Bot] Online as ${client.user.tag}`);
  ready = true;
  await registerCommands();
  await syncGuildMembers();
});

// ── Auto-refresh stored embeds ─────────────────────────────────────────────────
async function refreshEmbeds() {
  if (!ready) return;
  const cfg = readConfig();

  if (cfg.warrantChannelId && cfg.warrantMessageId) {
    try {
      const ch  = await client.channels.fetch(cfg.warrantChannelId);
      const msg = await ch.messages.fetch(cfg.warrantMessageId);
      const activeWarrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active');
      const row = buildWarrantsMenu();
      await msg.edit({ embeds: [buildWarrantHeaderEmbed(activeWarrants.length)], components: row ? [row] : [] });
    } catch (err) {
      console.error('[DOJ Bot] Could not refresh warrant embed:', err.message);
    }
  }

  if (cfg.caseChannelId && cfg.caseMessageId) {
    try {
      const ch  = await client.channels.fetch(cfg.caseChannelId);
      const msg = await ch.messages.fetch(cfg.caseMessageId);
      const activeCases = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status));
      const row = buildCasesMenu();
      await msg.edit({ embeds: [buildCaseHeaderEmbed(activeCases.length)], components: row ? [row] : [] });
    } catch (err) {
      console.error('[DOJ Bot] Could not refresh case embed:', err.message);
    }
  }
}

// ── Notify linked case threads of a portal update ─────────────────────────────
async function notifyCaseUpdate(caseId, updatedBy) {
  if (!ready) return;
  try {
    const cases = readJSON(CASES_FILE);
    const c = cases.find(x => x.id === caseId);
    if (!c || !c.discordLink) return;

    const { discoveryThreadId, documentsThreadId } = c.discordLink;

    if (discoveryThreadId) {
      const thread = await client.channels.fetch(discoveryThreadId).catch(() => null);
      if (thread) {
        await thread.send({ embeds: [buildCaseStatusUpdateEmbed(c, updatedBy)] });

        if (['closed', 'dismissed'].includes(c.status)) {
          const reason = `Case ${c.caseNumber} ${c.status} on DOJ Portal`;
          await thread.setLocked(true, reason).catch(() => {});
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`Thread Locked — ${c.caseNumber}`)
                .setColor(0x6b7280)
                .setThumbnail(DOJ_LOGO)
                .setDescription(
                  `This case has been **${c.status}** on the DOJ Portal.\n\n` +
                  `This thread is now locked and preserved as an official record. ` +
                  `All exhibits and documents remain accessible on the portal.`
                )
                .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
                .setTimestamp()
            ]
          }).catch(() => {});
        }
      }
    }

    if (['closed', 'dismissed'].includes(c.status) && documentsThreadId) {
      const docsThread = await client.channels.fetch(documentsThreadId).catch(() => null);
      if (docsThread) await docsThread.setLocked(true).catch(() => {});
    }
  } catch (err) {
    console.error('[DOJ Bot] notifyCaseUpdate error:', err.message);
  }
}

// ── Thread message handler — exhibit and document cataloging ──────────────────
async function handleThreadMessage(message) {
  if (!message.attachments.size) return;

  const threadId = message.channel.id;
  const cases    = readJSON(CASES_FILE);

  const cIdx = cases.findIndex(x =>
    x.discordLink && (
      x.discordLink.discoveryThreadId === threadId ||
      x.discordLink.documentsThreadId === threadId
    )
  );
  if (cIdx === -1) return;

  const c          = cases[cIdx];
  const isDiscovery = c.discordLink.discoveryThreadId === threadId;
  const isDocuments = c.discordLink.documentsThreadId === threadId;
  const addedBy     = message.member?.displayName || message.author.username;

  let newExhibitCount = 0;
  let newDocCount     = 0;

  for (const [, attachment] of message.attachments) {
    const ext  = path.extname(attachment.name || '').toLowerCase().slice(1) || 'file';

    if (isDiscovery) {
      if (!cases[cIdx].exhibits) cases[cIdx].exhibits = [];
      const letter = toExhibitLetter(cases[cIdx].exhibits.length);
      cases[cIdx].exhibits.push({
        id:              newId(),
        letter,
        filename:        attachment.name,
        url:             attachment.url,
        type:            ext.toUpperCase(),
        addedBy,
        addedByDiscordId: message.author.id,
        addedAt:         new Date().toISOString(),
        messageId:       message.id,
        threadId,
        status:          'pending',
        description:     ''
      });
      newExhibitCount++;
    } else if (isDocuments) {
      if (!cases[cIdx].courtDocuments) cases[cIdx].courtDocuments = [];
      cases[cIdx].courtDocuments.push({
        id:              newId(),
        filename:        attachment.name,
        url:             attachment.url,
        type:            ext.toUpperCase(),
        addedBy,
        addedByDiscordId: message.author.id,
        addedAt:         new Date().toISOString(),
        messageId:       message.id
      });
      newDocCount++;
    }
  }

  if (newExhibitCount > 0 || newDocCount > 0) {
    cases[cIdx].updatedAt = new Date().toISOString();
    writeJSON(CASES_FILE, cases);
  }

  // Confirm each new exhibit
  if (newExhibitCount > 0) {
    const freshCases  = readJSON(CASES_FILE);
    const freshCase   = freshCases[cIdx];
    const newExhibits = freshCase.exhibits.slice(-newExhibitCount);

    for (const exhibit of newExhibits) {
      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Exhibit ${exhibit.letter} Cataloged — ${c.caseNumber}`)
            .setColor(0x7c3aed)
            .setThumbnail(DOJ_LOGO)
            .setDescription(
              `**${exhibit.filename}** has been officially cataloged as **Exhibit ${exhibit.letter}** in case **${c.caseNumber}**.`
            )
            .addFields(
              { name: 'File Type',    value: exhibit.type,                            inline: true },
              { name: 'Submitted By', value: exhibit.addedBy,                         inline: true },
              { name: 'Status',       value: 'Pending admission by the court',        inline: true }
            )
            .setFooter({ text: 'Exhibits can be admitted or rejected from the DOJ Portal', iconURL: DOJ_LOGO })
            .setTimestamp()
        ]
      }).catch(() => {});
    }

    // Update or create the pinned exhibit registry
    try {
      const registryEmbed = buildExhibitRegistryEmbed(freshCase);
      const regMsgId      = freshCase.discordLink?.exhibitRegistryMessageId;

      if (regMsgId) {
        const existing = await message.channel.messages.fetch(regMsgId).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [registryEmbed] });
        } else {
          const newReg = await message.channel.send({ embeds: [registryEmbed] });
          await newReg.pin().catch(() => {});
          const fc2 = readJSON(CASES_FILE);
          if (fc2[cIdx]?.discordLink) {
            fc2[cIdx].discordLink.exhibitRegistryMessageId = newReg.id;
            writeJSON(CASES_FILE, fc2);
          }
        }
      } else {
        const newReg = await message.channel.send({ embeds: [registryEmbed] });
        await newReg.pin().catch(() => {});
        const fc2 = readJSON(CASES_FILE);
        if (fc2[cIdx]?.discordLink) {
          fc2[cIdx].discordLink.exhibitRegistryMessageId = newReg.id;
          writeJSON(CASES_FILE, fc2);
        }
      }
    } catch (err) {
      console.error('[DOJ Bot] Exhibit registry update error:', err.message);
    }
  }

  // Confirm documents filed
  if (isDocuments && newDocCount > 0) {
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle(`${newDocCount} Document${newDocCount > 1 ? 's' : ''} Filed — ${c.caseNumber}`)
          .setThumbnail(DOJ_LOGO)
          .setDescription(
            `${newDocCount} document${newDocCount > 1 ? 's have' : ' has'} been officially filed ` +
            `in case **${c.caseNumber}** and recorded on the DOJ Portal.`
          )
          .addFields({ name: 'Filed By', value: addedBy, inline: true })
          .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
          .setTimestamp()
      ]
    }).catch(() => {});
  }
}

// ── Interaction handler ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const warrantChannel = interaction.options.getChannel('warrant_channel');
    const caseChannel    = interaction.options.getChannel('case_channel');
    const activeWarrants = readJSON(WARRANTS_FILE).filter(w => w.status === 'active');
    const activeCases    = readJSON(CASES_FILE).filter(c => !['closed', 'dismissed'].includes(c.status));

    const warrantRow = buildWarrantsMenu();
    let warrantMsg;
    try {
      warrantMsg = await warrantChannel.send({
        embeds: [buildWarrantHeaderEmbed(activeWarrants.length)],
        components: warrantRow ? [warrantRow] : []
      });
    } catch (err) {
      console.error('[DOJ Bot] Failed to post warrant embed:', err.message);
      return interaction.editReply({ content: `Could not post to <#${warrantChannel.id}>. Ensure the bot has Send Messages permission in that channel.` });
    }

    const caseRow = buildCasesMenu();
    let caseMsg;
    try {
      caseMsg = await caseChannel.send({
        embeds: [buildCaseHeaderEmbed(activeCases.length)],
        components: caseRow ? [caseRow] : []
      });
    } catch (err) {
      console.error('[DOJ Bot] Failed to post case embed:', err.message);
      return interaction.editReply({ content: `Could not post to <#${caseChannel.id}>. Ensure the bot has Send Messages permission in that channel.` });
    }

    writeConfig({
      warrantChannelId: warrantChannel.id,
      warrantMessageId: warrantMsg.id,
      caseChannelId:    caseChannel.id,
      caseMessageId:    caseMsg.id
    });

    return interaction.editReply({
      content:
        `Setup complete.\n` +
        `Warrant lookup posted in <#${warrantChannel.id}>\n` +
        `Case lookup posted in <#${caseChannel.id}>\n\n` +
        `Embeds will update automatically whenever a case or warrant is added, edited, or removed.`
    });
  }

  // /link
  if (interaction.isChatInputCommand() && interaction.commandName === 'link') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!canLinkCase(interaction.member)) {
      return interaction.editReply({
        content: 'Access denied. You require a Clerk, Attorney, Judge, or AG role to link cases.'
      });
    }

    const caseNumber = interaction.options.getString('case_number').trim().toUpperCase();
    const cases      = readJSON(CASES_FILE);
    const cIdx       = cases.findIndex(x => x.caseNumber.toUpperCase() === caseNumber);

    if (cIdx === -1) {
      return interaction.editReply({
        content: `No case found with number **${caseNumber}**. Verify the case number on the DOJ Portal.`
      });
    }

    const c = cases[cIdx];

    if (c.discordLink && c.discordLink.discoveryThreadId) {
      return interaction.editReply({
        content:
          `Case **${c.caseNumber}** is already linked.\n\n` +
          `Discovery: <#${c.discordLink.discoveryThreadId}>\n` +
          `Documents: <#${c.discordLink.documentsThreadId}>\n\n` +
          `Use \`/unlink ${c.caseNumber}\` to remove the existing link first.`
      });
    }

    const channel = interaction.channel;
    if (!channel || !channel.threads) {
      return interaction.editReply({
        content: 'Threads cannot be created in this channel type. Run this command in a standard text channel.'
      });
    }

    try {
      const linkedBy = interaction.member.displayName || interaction.user.username;

      const announcementMsg = await channel.send({ embeds: [buildCaseLinkAnnouncementEmbed(c, linkedBy)] });

      const discoveryThread = await channel.threads.create({
        name: `Discovery — ${c.caseNumber}`,
        autoArchiveDuration: 10080,
        reason: `Case ${c.caseNumber} linked by ${interaction.user.username}`
      });

      const documentsThread = await channel.threads.create({
        name: `Documents — ${c.caseNumber}`,
        autoArchiveDuration: 10080,
        reason: `Case ${c.caseNumber} linked by ${interaction.user.username}`
      });

      // Welcome message in Discovery thread
      const discoveryWelcome = await discoveryThread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Discovery — ${c.caseNumber}`)
            .setColor(0x7c3aed)
            .setThumbnail(DOJ_LOGO)
            .setDescription(
              `**${c.title}**\n\n` +
              `This is the official Discovery thread for this case.\n\n` +
              `Any file submitted here — regardless of type — will be automatically cataloged as a numbered exhibit (Exhibit A, B, C...) and recorded on the DOJ Portal.\n\n` +
              `The presiding judge may admit or reject exhibits directly from the portal. ` +
              `A live Exhibit Registry is pinned below and updates with each new submission.`
            )
            .addFields(
              { name: 'Defendant',  value: c.subject || 'N/A',         inline: true },
              { name: 'Prosecutor', value: c.prosecutor || 'N/A',      inline: true },
              { name: 'Defense',    value: c.defenseAttorney || 'N/A', inline: true },
              { name: 'Status',     value: cap(c.status),              inline: true },
              { name: 'Linked By',  value: linkedBy,                   inline: true }
            )
            .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
            .setTimestamp()
        ]
      });
      await discoveryWelcome.pin().catch(() => {});

      const registryMsg = await discoveryThread.send({ embeds: [buildExhibitRegistryEmbed(c)] });
      await registryMsg.pin().catch(() => {});

      // Welcome message in Documents thread
      await documentsThread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Court Documents — ${c.caseNumber}`)
            .setColor(0x3b82f6)
            .setThumbnail(DOJ_LOGO)
            .setDescription(
              `**${c.title}**\n\n` +
              `This is the official Court Documents thread for this case.\n\n` +
              `Post motions, orders, complaints, and official filings here. ` +
              `All documents are automatically logged to the DOJ Portal.`
            )
            .addFields(
              { name: 'Defendant', value: c.subject || 'N/A', inline: true },
              { name: 'Status',    value: cap(c.status),       inline: true }
            )
            .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
            .setTimestamp()
        ]
      });

      // Save link to case
      cases[cIdx].discordLink = {
        channelId:                channel.id,
        channelName:              channel.name,
        discoveryThreadId:        discoveryThread.id,
        documentsThreadId:        documentsThread.id,
        linkedBy,
        linkedByDiscordId:        interaction.user.id,
        linkedAt:                 new Date().toISOString(),
        guildId:                  interaction.guildId,
        announcementMessageId:    announcementMsg.id,
        exhibitRegistryMessageId: registryMsg.id
      };
      cases[cIdx].updatedAt = new Date().toISOString();
      writeJSON(CASES_FILE, cases);

      return interaction.editReply({
        content:
          `Case **${c.caseNumber} — ${c.title}** has been successfully linked.\n\n` +
          `Discovery: <#${discoveryThread.id}>\n` +
          `Documents: <#${documentsThread.id}>\n\n` +
          `Submit any file to the Discovery thread to catalog it as an exhibit.`
      });

    } catch (err) {
      console.error('[DOJ Bot] /link error:', err.message);
      return interaction.editReply({ content: `Failed to link case: ${err.message}` });
    }
  }

  // /unlink
  if (interaction.isChatInputCommand() && interaction.commandName === 'unlink') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!canLinkCase(interaction.member)) {
      return interaction.editReply({
        content: 'Access denied. You require a Clerk, Attorney, Judge, or AG role to unlink cases.'
      });
    }

    const caseNumber = interaction.options.getString('case_number').trim().toUpperCase();
    const cases      = readJSON(CASES_FILE);
    const cIdx       = cases.findIndex(x => x.caseNumber.toUpperCase() === caseNumber);

    if (cIdx === -1) {
      return interaction.editReply({ content: `No case found with number **${caseNumber}**.` });
    }

    const c    = cases[cIdx];
    const link = c.discordLink;

    if (!link) {
      return interaction.editReply({ content: `Case **${c.caseNumber}** is not linked to any Discord threads.` });
    }

    const unlinkedBy = interaction.member.displayName || interaction.user.username;
    cases[cIdx].discordLink = null;
    cases[cIdx].updatedAt   = new Date().toISOString();
    writeJSON(CASES_FILE, cases);

    const unlinkEmbed = new EmbedBuilder()
      .setTitle(`Case Unlinked — ${c.caseNumber}`)
      .setColor(0xef4444)
      .setThumbnail(DOJ_LOGO)
      .setDescription(
        `This case has been unlinked from Discord by **${unlinkedBy}**.\n\n` +
        `This thread is preserved as an archived record. ` +
        `All exhibits remain accessible on the DOJ Portal.`
      )
      .setFooter({ text: 'State of Texas — Department of Justice', iconURL: DOJ_LOGO })
      .setTimestamp();

    if (link.discoveryThreadId) {
      const thread = await client.channels.fetch(link.discoveryThreadId).catch(() => null);
      if (thread) {
        await thread.send({ embeds: [unlinkEmbed] }).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }
    }
    if (link.documentsThreadId) {
      const thread = await client.channels.fetch(link.documentsThreadId).catch(() => null);
      if (thread) {
        await thread.send({ embeds: [unlinkEmbed] }).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }
    }

    return interaction.editReply({
      content: `Case **${c.caseNumber}** has been unlinked. Both threads have been archived.`
    });
  }

  // Warrant dropdown
  if (interaction.isStringSelectMenu() && interaction.customId === 'warrant_lookup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const w = readJSON(WARRANTS_FILE).find(x => x.id === interaction.values[0]);
    if (!w) return interaction.editReply({ content: 'Warrant not found. The list may have been updated.' });

    const replyPayload = { embeds: [buildWarrantEmbed(w)] };
    if (w.pdfFile) {
      const pdfPath    = path.join(WARRANT_PDFS_DIR, w.pdfFile);
      const legacyPath = path.join(WARRANT_REQ_DIR, w.pdfFile);
      const resolved   = fs.existsSync(pdfPath) ? pdfPath : fs.existsSync(legacyPath) ? legacyPath : null;
      if (resolved) {
        try {
          replyPayload.files = [new AttachmentBuilder(resolved, { name: w.pdfName || `Warrant-${w.warrantNumber}.pdf` })];
        } catch (_) {}
      }
    }
    return interaction.editReply(replyPayload);
  }

  // Case dropdown
  if (interaction.isStringSelectMenu() && interaction.customId === 'case_lookup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const c = readJSON(CASES_FILE).find(x => x.id === interaction.values[0]);
    if (!c) return interaction.editReply({ content: 'Case not found. The list may have been updated.' });
    return interaction.editReply({ embeds: [buildCaseEmbed(c)] });
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  // Thread exhibit / document detection (any guild member)
  if (typeof message.channel.isThread === 'function' && message.channel.isThread()) {
    await handleThreadMessage(message).catch(err =>
      console.error('[DOJ Bot] handleThreadMessage error:', err.message)
    );
  }

  // Owner-only text commands
  if (message.author.id !== OWNER_ID) return;

  const content = message.content.trim();

  if (content === '$git restart') {
    await ownerDM(message, 'Pulling latest code and restarting the server...');
    const { err, stdout, stderr } = await runCmd('git pull && npm install --production && systemctl restart doj-portal');
    if (err) {
      await message.author.send(`Restart failed:\n\`\`\`\n${(stderr || err.message).slice(0, 1800)}\n\`\`\``).catch(() => {});
    } else {
      await message.author.send(`Done.\n\`\`\`\n${stdout.slice(0, 1800)}\n\`\`\``).catch(() => {});
    }
    return;
  }

  if (content === '$git stash') {
    await ownerDM(message, 'Running git stash...');
    const { err, stdout, stderr } = await runCmd('git stash');
    if (err) {
      await message.author.send(`git stash failed:\n\`\`\`\n${(stderr || err.message).slice(0, 1800)}\n\`\`\``).catch(() => {});
    } else {
      await message.author.send(`\`\`\`\n${stdout || 'No local changes to save.'}\n\`\`\``).catch(() => {});
    }
    return;
  }

  if (content === '$git v') {
    const [branch, log, status, gitver] = await Promise.all([
      runCmd('git branch --show-current'),
      runCmd('git log --oneline -5'),
      runCmd('git status --short'),
      runCmd('git --version')
    ]);
    const out = [
      `**${gitver.stdout}**`,
      `**Branch:** ${branch.stdout || 'unknown'}`,
      `**Recent commits:**\n\`\`\`\n${log.stdout || 'none'}\n\`\`\``,
      status.stdout ? `**Working tree:**\n\`\`\`\n${status.stdout.slice(0, 800)}\n\`\`\`` : '**Working tree:** clean'
    ].join('\n');
    await ownerDM(message, out);
    return;
  }

  if (content === '$refresh') {
    await ownerDM(message, 'Refreshing embeds and syncing guild members...');
    try {
      const [, added] = await Promise.all([refreshEmbeds(), syncGuildMembers()]);
      await message.author.send(`Done. Embeds updated. ${added} new player record(s) synced.`).catch(() => {});
    } catch (err) {
      await message.author.send(`Refresh failed: ${err.message}`).catch(() => {});
    }
  }
});

// ── Owner DM helpers ──────────────────────────────────────────────────────────
async function ownerDM(message, text) {
  try { await message.delete(); } catch (_) {}
  try {
    await message.author.send(text);
  } catch (_) {
    const tmp = await message.channel.send(text).catch(() => null);
    if (tmp) setTimeout(() => tmp.delete().catch(() => {}), 15000);
  }
}

function runCmd(cmd) {
  return new Promise(resolve => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

client.login(TOKEN).catch(err => {
  console.error('[DOJ Bot] Login failed:', err.message);
});

module.exports = { refreshEmbeds, notifyCaseUpdate };
