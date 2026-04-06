// bot.js
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const admin = require('firebase-admin');
const { randomBytes } = require('crypto');

// ---------------------- Firebase Setup ----------------------
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch (err) {
  console.error("🔥 FIREBASE ENV ERROR:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});
const db = admin.database();

// ---------------------- Discord Bot Setup ----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const OWNER_ID = process.env.OWNER_ID;
const TOKEN = process.env.TOKEN;

// ---------------------- Helper Functions ----------------------
function formatTime(date, locale = 'en-US') {
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });
}

// Check if user is authorized
async function isAuthorized(userId) {
  if (userId === OWNER_ID) return true;
  const ref = db.ref(`authorized/${userId}`);
  const snapshot = await ref.once('value');
  return snapshot.exists();
}

// Cleanup expired or used keys
setInterval(async () => {
  const snapshot = await db.ref('keys').once('value');
  const now = new Date();
  snapshot.forEach(child => {
    const data = child.val();
    if (!data) return;
    const expiry = new Date(data.expiry);
    if (expiry < now || data.used >= data.maxUses) {
      child.ref.remove();
    }
  });
}, 60000);

// ---------------------- Commands ----------------------
client.once('ready', async () => {
  console.log(`🚀 Bot logged in as ${client.user.tag}`);

  // Register slash commands
  const commands = [
    new SlashCommandBuilder().setName('hire').setDescription('Hire a user').addUserOption(opt => opt.setName('user').setDescription('User to hire')),
    new SlashCommandBuilder().setName('fire').setDescription('Fire a user').addUserOption(opt => opt.setName('user').setDescription('User to fire')),
    new SlashCommandBuilder().setName('lock').setDescription('Lock channels').addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock')),
    new SlashCommandBuilder().setName('keyv').setDescription('Post key verification message').addChannelOption(opt => opt.setName('channel').setDescription('Channel for verification'))
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// ---------------------- Interaction Handler ----------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

  const userId = interaction.user.id;

  // ---------------------- /hire ----------------------
  if (interaction.isChatInputCommand() && interaction.commandName === 'hire') {
    if (userId !== OWNER_ID) return interaction.reply({ content: '❌ You cannot run this.', ephemeral: true });
    const target = interaction.options.getUser('user');
    await db.ref(`authorized/${target.id}`).set(true);
    return interaction.reply({ content: `✅ Hired ${target.tag}`, ephemeral: true });
  }

  // ---------------------- /fire ----------------------
  if (interaction.isChatInputCommand() && interaction.commandName === 'fire') {
    if (userId !== OWNER_ID) return interaction.reply({ content: '❌ You cannot run this.', ephemeral: true });
    const target = interaction.options.getUser('user');
    await db.ref(`authorized/${target.id}`).remove();
    return interaction.reply({ content: `❌ Fired ${target.tag}`, ephemeral: true });
  }

  // ---------------------- /lock ----------------------
  if (interaction.isChatInputCommand() && interaction.commandName === 'lock') {
    if (!await isAuthorized(userId)) return interaction.reply({ content: '❌ Not authorized', ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    if (!channel) return interaction.reply({ content: '❌ Channel not found', ephemeral: true });
    await db.ref(`locks/${channel.id}`).set({ locked: true });
    return interaction.reply({ content: `🔒 Locked ${channel.name}`, ephemeral: true });
  }

  // ---------------------- /keyv ----------------------
  if (interaction.isChatInputCommand() && interaction.commandName === 'keyv') {
    if (!await isAuthorized(userId)) return interaction.reply({ content: '❌ Not authorized', ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    if (!channel) return interaction.reply({ content: '❌ Channel not found', ephemeral: true });

    // Send verification message
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('redeem_key')
        .setLabel('Redeem Key')
        .setStyle(ButtonStyle.Primary)
    );
    await channel.send({ content: '🔑 Click to redeem your key', components: [row] });
    return interaction.reply({ content: `✅ Verification posted in ${channel.name}`, ephemeral: true });
  }

  // ---------------------- Redeem Button ----------------------
  if (interaction.isButton() && interaction.customId === 'redeem_key') {
    const modal = new ModalBuilder()
      .setCustomId('key_modal')
      .setTitle('Redeem Key');
    const input = new TextInputBuilder()
      .setCustomId('key_input')
      .setLabel('Paste your key here')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);
    await interaction.showModal(modal);
  }

  // ---------------------- Modal Submit ----------------------
  if (interaction.isModalSubmit() && interaction.customId === 'key_modal') {
    const key = interaction.fields.getTextInputValue('key_input');
    const ref = db.ref('keys/' + key);
    const snap = await ref.once('value');
    if (!snap.exists()) return interaction.reply({ content: '❌ Invalid key', ephemeral: true });
    const data = snap.val();
    const now = new Date();

    // Expiry check
    if (new Date(data.expiry) < now) {
      await ref.remove();
      return interaction.reply({ content: '❌ Key expired', ephemeral: true });
    }
    if (data.used >= data.maxUses) {
      await ref.remove();
      return interaction.reply({ content: '❌ Key fully used', ephemeral: true });
    }

    // Update usage
    await ref.update({ used: data.used + 1 });
    const remainingUses = data.maxUses - (data.used + 1);

    // Send embed with countdown
    const embed = new EmbedBuilder()
      .setTitle('✅ Key Redeemed')
      .addFields(
        { name: 'Key', value: key },
        { name: 'Created At', value: formatTime(new Date(data.createdAt)) },
        { name: 'Expiry', value: formatTime(new Date(data.expiry)) },
        { name: 'Uses Left', value: remainingUses.toString() }
      )
      .setColor('Green');

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ---------------------- Login ----------------------
client.login(TOKEN);
