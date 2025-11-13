require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3').verbose();

// Config from env
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || null;
const SHIFT_ROLE_ID = process.env.SHIFT_ROLE_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('ERROR: TOKEN und CLIENT_ID müssen in .env gesetzt sein.');
  process.exit(1);
}

// Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

// DB init
let db;
(async () => {
  db = await sqlite.open({ filename: './data.sqlite', driver: sqlite3.Database });
  await db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    start_ts INTEGER,
    pause_ts INTEGER,
    resume_ts INTEGER,
    end_ts INTEGER,
    total_seconds INTEGER DEFAULT 0,
    type TEXT,
    status TEXT
  )`);
  await db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    guild_id TEXT,
    actor_id TEXT,
    action TEXT,
    data TEXT,
    ts INTEGER
  )`);
  await db.run(`CREATE TABLE IF NOT EXISTS loa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    guild_id TEXT,
    start_ts INTEGER,
    end_ts INTEGER,
    reason TEXT,
    status TEXT,
    actor_id TEXT
  )`);
})().catch(err => { console.error('DB init error', err); process.exit(1); });

// Helpers
const now = () => Math.floor(Date.now() / 1000);
const secsToHMS = s => {
  const h = Math.floor(s / 3600);
  s = s % 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
};
async function logAction(userId, guildId, actorId, action, data = '') {
  try {
    await db.run('INSERT INTO logs (user_id,guild_id,actor_id,action,data,ts) VALUES (?,?,?,?,?,?)', [userId, guildId, actorId, action, data, now()]);
  } catch (e) {
    console.warn('logAction failed', e.message);
  }
}
async function assignShiftRole(member) {
  if (!SHIFT_ROLE_ID || !member) return;
  try {
    const role = member.guild.roles.cache.get(SHIFT_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (e) { console.warn('assignShiftRole failed:', e.message); }
}
async function removeShiftRole(member) {
  if (!SHIFT_ROLE_ID || !member) return;
  try {
    const role = member.guild.roles.cache.get(SHIFT_ROLE_ID);
    if (role) await member.roles.remove(role);
  } catch (e) { console.warn('removeShiftRole failed:', e.message); }
}
function isAdmin(member) {
  if (!member) return false;
  try {
    if (ADMIN_ROLE_ID) return member.roles.cache.has(ADMIN_ROLE_ID) || member.permissions.has(PermissionFlagsBits.ManageGuild);
    return member.permissions.has(PermissionFlagsBits.ManageGuild);
  } catch { return false; }
}
// Modern dark embed default color + small icons (use emoji or small unicode icons)
const EMBED_COLOR = 0x0b1020; // very dark blue/gray
const ICONS = {
  user: ':bust_in_silhouette:',
  time: '⏱',
  type: ':label:',
  start: ':arrow_forward:',
  end: '⏹',
  pause: '⏸',
  loa: ':pencil:'
};

function buildDetailedShiftEmbed(userObj, shiftRow, actor = null, actionLabel = null) {
  const embed = new EmbedBuilder()
    .setTitle(`${ICONS.time} Shift`)
    .setColor(EMBED_COLOR)
    .setAuthor({ name: userObj.tag, iconURL: userObj.displayAvatarURL() })
    .addFields(
      { name: `${ICONS.user} User`, value: `<@${shiftRow.user_id}>`, inline: true },
      { name: `${ICONS.type} Type`, value: shiftRow.type || '—', inline: true },
      { name: `${ICONS.time} Total`, value: shiftRow.total_seconds ? secsToHMS(shiftRow.total_seconds) : '0s', inline: true },
      { name: 'Start', value: shiftRow.start_ts ? `<t:${shiftRow.start_ts}:f>` : '—', inline: true },
      { name: 'Last pause', value: shiftRow.pause_ts ? `<t:${shiftRow.pause_ts}:f>` : '—', inline: true },
      { name: 'Last resume', value: shiftRow.resume_ts ? `<t:${shiftRow.resume_ts}:f>` : '—', inline: true },
      { name: 'End', value: shiftRow.end_ts ? `<t:${shiftRow.end_ts}:f>` : '—', inline: true }
    )
    .setTimestamp()
    .setFooter({ text: `Shift ID: ${shiftRow.id}` });

  if (actor && actionLabel) {
    embed.addFields({ name: '\u200B', value: `────────────────────────────\n${actionLabel}: ${actor.username} · Shift ID: #${shiftRow.id}` });
  }
  return embed;
}

function buildLoAEmbed(row, actor = null, actionLabel = null) {
  const embed = new EmbedBuilder()
    .setTitle(`${ICONS.loa} LoA Request`)
    .setColor(EMBED_COLOR)
    .addFields(
      { name: 'ID', value: `${row.id}`, inline: true },
      { name: 'User', value: `<@${row.user_id}>`, inline: true },
      { name: 'Status', value: `${row.status}`, inline: true },
      { name: 'Range', value: row.start_ts ? `<t:${row.start_ts}:d>` + ' - ' + `<t:${row.end_ts}:d>` : '—', inline: false },
      { name: 'Reason', value: row.reason || '—', inline: false }
    )
    .setTimestamp();
  if (actor && actionLabel) {
    embed.addFields({ name: '\u200B', value: `${actionLabel}: ${actor.username} · LoA ID: #${row.id}` });
  }
  return embed;
}

// Buttons builder
function buildShiftButtons(shiftId, status, forAdmin = false) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder().setCustomId(`shift_start_${shiftId || 'new'}`).setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(status === 'active'),
    new ButtonBuilder().setCustomId(`shift_pause_${shiftId || 'none'}`).setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(!(status === 'active')),
    new ButtonBuilder().setCustomId(`shift_resume_${shiftId || 'none'}`).setLabel('Resume').setStyle(ButtonStyle.Primary).setDisabled(!(status === 'paused')),
    new ButtonBuilder().setCustomId(`shift_end_${shiftId || 'none'}`).setLabel('End').setStyle(ButtonStyle.Danger).setDisabled(!(status === 'active' || status === 'paused'))
  );
  if (forAdmin) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`shift_forceend_${shiftId || 'none'}`).setLabel('Force End').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`shift_edit_${shiftId || 'none'}`).setLabel('Edit').setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}
// Register commands
const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Shift commands')
    .addSubcommand(sub => 
      sub.setName('start')
         .setDescription('Start a shift')
         .addStringOption(o => o.setName('type').setDescription('Shift type'))
    )
    .addSubcommand(sub => sub.setName('pause').setDescription('Pause your active shift'))
    .addSubcommand(sub => sub.setName('resume').setDescription('Resume a paused shift'))
    .addSubcommand(sub => sub.setName('end').setDescription('End your active shift'))
    .addSubcommand(sub => 
      sub.setName('logs')
         .setDescription('View your shift logs')
         .addIntegerOption(o => o.setName('limit').setDescription('Max lines'))
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('shift-manage')
    .setDescription('Admin shift management')
    .addSubcommand(sub => 
      sub.setName('bulk-end')
         .setDescription('End multiple shifts')
         .addUserOption(o => o.setName('user').setDescription('Filter by user'))
         .addStringOption(o => o.setName('before').setDescription('Before date YYYY-MM-DD'))
    )
    .addSubcommand(sub => 
      sub.setName('bulk-delete')
         .setDescription('Delete multiple shifts')
         .addUserOption(o => o.setName('user').setDescription('Filter by user'))
         .addStringOption(o => o.setName('before').setDescription('Before date YYYY-MM-DD'))
         .addStringOption(o => o.setName('ids').setDescription('Comma-separated IDs'))
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('loa')
    .setDescription('Leave of Absence commands')
    .addSubcommand(sub => 
      sub.setName('request')
         .setDescription('Request LoA')
         .addStringOption(o => o.setName('duration').setDescription('e.g. 3d, 2w').setRequired(true))
         .addStringOption(o => o.setName('reason').setDescription('Reason for LoA'))
    )
    .addSubcommand(sub => sub.setName('list').setDescription('List your LoAs'))
    .addSubcommand(sub => sub.setName('status').setDescription('Check your LoA status'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('loa-manage')
    .setDescription('Admin LoA management')
    .addSubcommand(sub => 
      sub.setName('approve')
         .setDescription('Approve LoA')
         .addIntegerOption(o => o.setName('id').setDescription('LoA ID').setRequired(true))
         .addStringOption(o => o.setName('note').setDescription('Optional note'))
    )
    .addSubcommand(sub => 
      sub.setName('deny')
         .setDescription('Deny LoA')
         .addIntegerOption(o => o.setName('id').setDescription('LoA ID').setRequired(true))
         .addStringOption(o => o.setName('note').setDescription('Optional note'))
    )
    .addSubcommand(sub => 
      sub.setName('list')
         .setDescription('List pending LoAs')
         .addIntegerOption(o => o.setName('limit').setDescription('Maximum number of entries'))
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered commands to guild', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered commands globally (may take up to 1 hour).');
    }
  } catch (e) {
    console.error('Failed to register commands', e);
  }
})();
// helper to send embed to configured log channel
async function sendLogChannelEmbed(guild, embed) {
  if (!LOG_CHANNEL_ID || !guild) return;
  try {
    const ch = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.send) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.warn('sendLogChannelEmbed error:', e.message);
  }
}

// Interaction handler (commands + buttons)
client.on('interactionCreate', async interaction => {
  try {
    // BUTTONS
    if (interaction.isButton()) {
      const parts = interaction.customId.split('_'); // e.g. shift_pause_12
      if (parts.length < 3) return interaction.reply({ content: 'Unbekannte Button-Aktion.', ephemeral: true });
      const [prefix, action, idStr] = parts;
      const id = parseInt(idStr);
      if (prefix !== 'shift' || isNaN(id)) return interaction.reply({ content: 'Ungültige Aktion.', ephemeral: true });

      const guild = interaction.guild;
      const member = interaction.member;
      const user = interaction.user;
      const row = await db.get('SELECT * FROM shifts WHERE id = ?', [id]);
      if (!row) return interaction.reply({ content: 'Schicht nicht gefunden.', ephemeral: true });

      // PAUSE
      if (action === 'pause') {
        if (row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'Du darfst diese Schicht nicht pausieren.', ephemeral: true });
        const pauseTs = now();
        const elapsed = Math.max(0, pauseTs - row.start_ts);
        const total = (row.total_seconds || 0) + elapsed;
        await db.run('UPDATE shifts SET pause_ts=?, status=?, total_seconds=? WHERE id=?', [pauseTs, 'paused', total, id]);
        await logAction(row.user_id, guild.id, user.id, 'shift_pause_button', `id=${id}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [id]);
        const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, user, 'Paused by');
        await interaction.update({ embeds: [embed], components: [buildShiftButtons(shift.id, 'paused', isAdmin(member))] });
        await sendLogChannelEmbed(guild, embed);
        return;
      }

      // RESUME
      if (action === 'resume') {
        if (row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'Du darfst diese Schicht nicht fortsetzen.', ephemeral: true });
        const resumeTs = now();
        await db.run('UPDATE shifts SET resume_ts=?, start_ts=?, status=? WHERE id=?', [resumeTs, resumeTs, 'active', id]);
        await logAction(row.user_id, guild.id, user.id, 'shift_resume_button', `id=${id}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [id]);
        const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, user, 'Resumed by');
        await interaction.update({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active', isAdmin(member))] });
        await sendLogChannelEmbed(guild, embed);
        return;
      }
      // END or FORCEEND
      if (action === 'end' || action === 'forceend') {
        if (action === 'end' && row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'Du darfst diese Schicht nicht beenden.', ephemeral: true });
        const endTs = now();
        let total = row.total_seconds || 0;
        if (row.status === 'active') total += Math.max(0, endTs - row.start_ts);
        await db.run('UPDATE shifts SET end_ts=?, status=?, total_seconds=? WHERE id=?', [endTs, 'ended', total, id]);
        try {
          const mem = await guild.members.fetch(row.user_id).catch(() => null);
          if (mem) await removeShiftRole(mem);
        } catch {}
        await logAction(row.user_id, guild.id, user.id, action === 'forceend' ? 'shift_forceend_button' : 'shift_end_button', `id=${id},total=${total}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [id]);
        const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, user, action === 'forceend' ? 'Force ended by' : 'Ended by');
        await interaction.update({ embeds: [embed], components: [] });
        await sendLogChannelEmbed(guild, embed);
        return;
      }

      // START (button)
      if (action === 'start') {
        const memberObj = interaction.member;
        const userObj = interaction.user;
        const type = 'normal';
        const startTs = now();
        const res = await db.run('INSERT INTO shifts (user_id,guild_id,start_ts,type,status) VALUES (?,?,?,?,?)', [userObj.id, guild.id, startTs, type, 'active']);
        const shiftId = res.lastID;
        await assignShiftRole(memberObj);
        await logAction(userObj.id, guild.id, userObj.id, 'shift_start_button', `id=${shiftId}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [shiftId]);
        const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, userObj, 'Started by');
        await interaction.update({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
        await sendLogChannelEmbed(guild, embed);
        return;
      }

      // EDIT (admin helper)
      if (action === 'edit') {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins dürfen Schichten bearbeiten.', ephemeral: true });
        return interaction.reply({ content: `Um Schicht ${id} zu bearbeiten, benutze /shift-manage (edit not in slash-set).`, ephemeral: true });
      }

      return interaction.reply({ content: 'Buttonaktion unbekannt.', ephemeral: true });
    }

    // COMMANDS (chat input)
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, member, guild, user } = interaction;
    const gid = guild ? guild.id : 'dm';
    const uid = user.id;

    // send to log channel helper
    async function maybeSendLog(embed) {
      if (LOG_CHANNEL_ID && guild) await sendLogChannelEmbed(guild, embed);
    }

    // ---------- SHIFT ----------
    if (commandName === 'shift') {
      const sub = options.getSubcommand();

      // START
      if (sub === 'start') {
        const type = options.getString('type') || 'normal';
        const startTs = now();
        const res = await db.run('INSERT INTO shifts (user_id,guild_id,start_ts,type,status) VALUES (?,?,?,?,?)', [uid, gid, startTs, type, 'active']);
        const shiftId = res.lastID;
        await assignShiftRole(member);
        await logAction(uid, gid, uid, 'shift_start', `id=${shiftId},type=${type}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [shiftId]);
        const embed = buildDetailedShiftEmbed(user, shift, user, 'Started by');
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
        await maybeSendLog(embed);
        return;
      }
     // PAUSE
      if (sub === 'pause') {
        const row = await db.get('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status=?', [uid, gid, 'active']);
        if (!row) return interaction.reply({ content: 'Keine aktive Schicht gefunden.', ephemeral: true });
        const pauseTs = now();
        const elapsed = Math.max(0, pauseTs - row.start_ts);
        const total = (row.total_seconds || 0) + elapsed;
        await db.run('UPDATE shifts SET pause_ts=?, status=?, total_seconds=? WHERE id=?', [pauseTs, 'paused', total, row.id]);
        await logAction(uid, gid, uid, 'shift_pause', `id=${row.id}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [row.id]);
        const embed = buildDetailedShiftEmbed(user, shift, user, 'Paused by');
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'paused')] });
        await maybeSendLog(embed);
        return;
      }

      // RESUME
      if (sub === 'resume') {
        const row = await db.get('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status=?', [uid, gid, 'paused']);
        if (!row) return interaction.reply({ content: 'Keine pausierte Schicht gefunden.', ephemeral: true });
        const resumeTs = now();
        await db.run('UPDATE shifts SET resume_ts=?, start_ts=?, status=? WHERE id=?', [resumeTs, resumeTs, 'active', row.id]);
        await logAction(uid, gid, uid, 'shift_resume', `id=${row.id}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [row.id]);
        const embed = buildDetailedShiftEmbed(user, shift, user, 'Resumed by');
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
        await maybeSendLog(embed);
        return;
      }
       // END
      if (sub === 'end') {
        const row = await db.get('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND (status=? OR status=?)', [uid, gid, 'active', 'paused']);
        if (!row) return interaction.reply({ content: 'Keine laufende oder pausierte Schicht gefunden.', ephemeral: true });
        const endTs = now();
        let total = row.total_seconds || 0;
        if (row.status === 'active') total += Math.max(0, endTs - row.start_ts);
        await db.run('UPDATE shifts SET end_ts=?, status=?, total_seconds=? WHERE id=?', [endTs, 'ended', total, row.id]);
        await removeShiftRole(member);
        await logAction(uid, gid, uid, 'shift_end', `id=${row.id},total=${total}`);
        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [row.id]);
        const embed = buildDetailedShiftEmbed(user, shift, user, 'Ended by');
        await interaction.reply({ embeds: [embed], components: [] });
        await maybeSendLog(embed);
        return;
      }

      // LOGS
      if (sub === 'logs') {
        const limit = Math.min(100, options.getInteger('limit') || 20);
        const rows = await db.all('SELECT * FROM logs WHERE user_id=? AND guild_id=? ORDER BY ts DESC LIMIT ?', [uid, gid, limit]);
        if (!rows.length) return interaction.reply({ content: 'Keine Logs gefunden.', ephemeral: true });
        const lines = rows.map(r => `${new Date(r.ts * 1000).toLocaleString()} | ${r.action} | by: ${r.actor_id || r.user_id} | ${r.data}`).join('\n');
        await interaction.reply({ content: '\n' + lines + '\n', ephemeral: true });
        return;
      }
    }

    // ---------- SHIFT-MANAGE ----------
    if (commandName === 'shift-manage') {
      if (!isAdmin(member)) return interaction.reply({ content: 'Nur Admins dürfen diesen Befehl verwenden.', ephemeral: true });
      const sub = options.getSubcommand();

      // bulk-end
      if (sub === 'bulk-end') {
        const filterUser = options.getUser('user');
        const before = options.getString('before');
        let query = 'SELECT * FROM shifts WHERE (status = ? OR status = ?) AND guild_id = ?';
        const params = ['active', 'paused', gid];
        if (filterUser) { query += ' AND user_id = ?'; params.push(filterUser.id); }
        if (before) { const ts = Math.floor(new Date(before).getTime() / 1000); query += ' AND start_ts < ?'; params.push(ts); }
        const rows = await db.all(query, params);
        if (!rows.length) return interaction.reply({ content: 'Keine Shifts gefunden für die Filter.', ephemeral: true });
        for (const r of rows) {
          const endTs = now();
          let total = r.total_seconds || 0;
          if (r.status === 'active') total += Math.max(0, endTs - r.start_ts);
          await db.run('UPDATE shifts SET end_ts=?, status=?, total_seconds=? WHERE id=?', [endTs, 'ended', total, r.id]);
          try { const mem = await guild.members.fetch(r.user_id).catch(() => null); if (mem) await removeShiftRole(mem); } catch {}
          await logAction(r.user_id, gid, member.user.id, 'shift_bulk_end', `id=${r.id},total=${total}`);
          const shiftRow = await db.get('SELECT * FROM shifts WHERE id = ?', [r.id]);
          const embed = buildDetailedShiftEmbed(await client.users.fetch(shiftRow.user_id), shiftRow, member.user, 'Ended by (admin bulk)');
          await maybeSendLog(embed);
        }
        return interaction.reply({ content: `Beendet: ${rows.length} Shifts.`, ephemeral: true });
      }
      // bulk-delete
      if (sub === 'bulk-delete') {
        const filterUser = options.getUser('user');
        const before = options.getString('before');
        const idsStr = options.getString('ids');
        let query = 'SELECT * FROM shifts WHERE guild_id = ?';
        const params = [gid];
        if (filterUser) { query += ' AND user_id = ?'; params.push(filterUser.id); }
        if (before) { const ts = Math.floor(new Date(before).getTime() / 1000); query += ' AND start_ts < ?'; params.push(ts); }
        if (idsStr) {
          const ids = idsStr.split(',').map(x => parseInt(x.trim())).filter(Boolean);
          if (!ids.length) return interaction.reply({ content: 'Keine gültigen IDs gefunden.', ephemeral: true });
          query += ' AND id IN (' + ids.join(',') + ')';
        }
        const rows = await db.all(query, params);
        if (!rows.length) return interaction.reply({ content: 'Keine Shifts gefunden zum Löschen.', ephemeral: true });
        for (const r of rows) {
          await db.run('DELETE FROM shifts WHERE id = ?', [r.id]);
          await logAction(r.user_id, gid, member.user.id, 'shift_bulk_delete', `id=${r.id}`);
          const embed = new EmbedBuilder().setTitle('Shift Deleted').setColor(EMBED_COLOR).setDescription(`Shift ID: ${r.id} deleted by ${member.user.tag}`).setTimestamp();
          await maybeSendLog(embed);
        }
        return interaction.reply({ content: `Gelöscht: ${rows.length} Shifts.`, ephemeral: true });
      }
    }

    // ---------- LOA ----------
    if (commandName === 'loa') {
      const sub = options.getSubcommand();

      // request
      if (sub === 'request') {
        const duration = options.getString('duration');
        const reason = options.getString('reason') || 'Keine Angabe';
        const startTs = now();
        let endTs = startTs;
        const m = duration.match(/^(\d+)([dw])$/i);
        if (m) {
          const val = parseInt(m[1], 10);
          const unit = m[2].toLowerCase();
          if (unit === 'd') endTs += val * 86400;
          if (unit === 'w') endTs += val * 7 * 86400;
        } else {
          const n = parseInt(duration, 10);
          if (!isNaN(n)) endTs += n * 86400;
        }
        const res = await db.run('INSERT INTO loa (user_id,guild_id,start_ts,end_ts,reason,status) VALUES (?,?,?,?,?,?)', [uid, gid, startTs, endTs, reason, 'pending']);
        const loaId = res.lastID;
        await logAction(uid, gid, uid, 'loa_request', `id=${loaId},reason=${reason}`);
        const embed = buildLoAEmbed({ id: loaId, user_id: uid, start_ts: startTs, end_ts: endTs, reason, status: 'pending' }, user, 'Requested by');
        await interaction.reply({ embeds: [embed], ephemeral: true });
        await maybeSendLog(embed);
        return;
      }
      // list
if (sub === 'list') {
const rows = await db.all('SELECT * FROM loa WHERE user_id = ? AND guild_id = ? ORDER BY id DESC LIMIT 50', [uid, gid]);
if (!rows.length) return interaction.reply({ content: 'Keine LoA-Anfragen gefunden.', ephemeral: true });
const msg = rows.map(r => `ID:${r.id} | ${r.status} | ${r.reason} | ${new Date(r.start_ts*1000).toLocaleDateString()} - ${new Date(r.end_ts*1000).toLocaleDateString()}`).join('\n');
       return interaction.reply({ content: '\n' + msg + '\n', ephemeral: true });
      }

      // status
      if (sub === 'status') {
        const row = await db.get('SELECT * FROM loa WHERE user_id = ? AND guild_id = ? ORDER BY id DESC LIMIT 1', [uid, gid]);
        if (!row) return interaction.reply({ content: 'Keine LoA gefunden.', ephemeral: true });
        const embed = buildLoAEmbed(row);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    // ---------- LOA-MANAGE ----------
    if (commandName === 'loa-manage') {
      if (!isAdmin(member)) return interaction.reply({ content: 'Nur Admins dürfen diesen Befehl verwenden.', ephemeral: true });
      const sub = options.getSubcommand();

      if (sub === 'approve') {
        const id = options.getInteger('id');
        const note = options.getString('note') || '';
        const row = await db.get('SELECT * FROM loa WHERE id = ?', [id]);
        if (!row) return interaction.reply({ content: 'LoA nicht gefunden.', ephemeral: true });
        await db.run('UPDATE loa SET status = ?, actor_id = ? WHERE id = ?', ['approved', member.user.id, id]);
        await logAction(row.user_id, gid, member.user.id, 'loa_approve', `id=${id},note=${note}`);
        const embed = buildLoAEmbed({ ...row, status: 'approved' }, member.user, 'Approved by');
        try {
          const usr = await client.users.fetch(row.user_id).catch(() => null);
          if (usr) await usr.send(`Deine LoA (ID: ${id}) wurde genehmigt.`);
        } catch {}
        await interaction.reply({ embeds: [embed], ephemeral: true });
        await maybeSendLog(embed);
        return;
      }

      if (sub === 'deny') {
        const id = options.getInteger('id');
        const note = options.getString('note') || '';
        const row = await db.get('SELECT * FROM loa WHERE id = ?', [id]);
        if (!row) return interaction.reply({ content: 'LoA nicht gefunden.', ephemeral: true });
        await db.run('UPDATE loa SET status = ?, actor_id = ? WHERE id = ?', ['denied', member.user.id, id]);
        await logAction(row.user_id, gid, member.user.id, 'loa_deny', `id=${id},note=${note}`);
        const embed = buildLoAEmbed({ ...row, status: 'denied' }, member.user, 'Denied by');
        try {
          const usr = await client.users.fetch(row.user_id).catch(() => null);
          if (usr) await usr.send(`Deine LoA (ID: ${id}) wurde abgelehnt.`);
        } catch {}
        await interaction.reply({ embeds: [embed], ephemeral: true });
        await maybeSendLog(embed);
        return;
      }

      if (sub === 'list') {
        const limit = Math.min(200, options.getInteger('limit') || 50);
        const rows = await db.all('SELECT * FROM loa WHERE guild_id = ? ORDER BY id DESC LIMIT ?', [gid, limit]);
        if (!rows.length) return interaction.reply({ content: 'Keine LoA-Anfragen.', ephemeral: true });
        const msg = rows.map(r => `ID:${r.id} | U:${r.user_id} | ${r.status} | ${r.reason} | ${new Date(r.start_ts*1000).toLocaleDateString()} - ${new Date(r.end_ts*1000).toLocaleDateString()}`).join('\n');
        return interaction.reply({ content: '\n' + msg + '\n', ephemeral: true });
      }
    }

  } catch (err) {
    console.error('interactionCreate error:', err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: 'Ein Fehler ist aufgetreten.', ephemeral: true }); } catch {}
  }
});

// Ready
client.once('ready', () => { console.log(`Bot ready as ${client.user.tag}`); });

// Login
client.login(TOKEN);