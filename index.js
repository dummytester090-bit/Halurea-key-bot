const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} = require('discord.js');

const express = require('express');
const fetch = require('node-fetch');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// ===== CONFIG =====
const OWNER_ID = process.env.OWNER_ID;
const BACKEND_URL = "https://halurea1.onrender.com"; // your backend

// ===== MEMORY STORAGE =====
let hiredUsers = new Set();
let lockedChannels = new Set();
let activeKeys = {}; // userId -> key data

// ===== KEEP BOT ALIVE =====
const app = express();
app.get('/', (req, res) => res.send('Bot Alive'));
app.listen(3000);

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('keyv')
    .setDescription('Send key verification panel'),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock a channel')
    .addChannelOption(opt => opt.setName('channel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock a channel')
    .addChannelOption(opt => opt.setName('channel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('hire')
    .setDescription('Give access')
    .addUserOption(opt => opt.setName('user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('fire')
    .setDescription('Remove access')
    .addUserOption(opt => opt.setName('user').setRequired(true))
];

// ===== REGISTER COMMANDS =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  console.log("Commands registered");
});

// ===== PERMISSION CHECK =====
function isAuthorized(userId) {
  return userId === OWNER_ID || hiredUsers.has(userId);
}

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {

  // ===== SLASH COMMANDS =====
  if (interaction.isChatInputCommand()) {

    // ONLY OWNER for hire/fire
    if (interaction.commandName === 'hire') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Not allowed", ephemeral: true });

      const user = interaction.options.getUser('user');
      hiredUsers.add(user.id);
      return interaction.reply(`Hired ${user.username}`);
    }

    if (interaction.commandName === 'fire') {
      if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Not allowed", ephemeral: true });

      const user = interaction.options.getUser('user');
      hiredUsers.delete(user.id);
      return interaction.reply(`Fired ${user.username}`);
    }

    // OTHER COMMANDS NEED AUTH
    if (!isAuthorized(interaction.user.id)) {
      return interaction.reply({ content: "Not authorized", ephemeral: true });
    }

    if (interaction.commandName === 'lock') {
      const channel = interaction.options.getChannel('channel');
      lockedChannels.add(channel.id);

      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false
      });

      return interaction.reply(`Locked ${channel.name}`);
    }

    if (interaction.commandName === 'unlock') {
      const channel = interaction.options.getChannel('channel');
      lockedChannels.delete(channel.id);

      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: true
      });

      return interaction.reply(`Unlocked ${channel.name}`);
    }

    if (interaction.commandName === 'keyv') {

      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('redeem')
          .setLabel('Redeem Key')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({
        content: "🔑 Redeem your key below",
        components: [button]
      });
    }
  }

  // ===== BUTTON =====
  if (interaction.isButton()) {

    if (interaction.customId === 'redeem') {

      if (activeKeys[interaction.user.id]) {
        return interaction.reply({ content: "You already have an active key!", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId('keyModal')
        .setTitle('Enter Key');

      const input = new TextInputBuilder()
        .setCustomId('keyInput')
        .setLabel('Paste your key')
        .setStyle(TextInputStyle.Short);

      modal.addComponents(new ActionRowBuilder().addComponents(input));

      return interaction.showModal(modal);
    }
  }

  // ===== MODAL =====
  if (interaction.isModalSubmit()) {

    if (interaction.customId === 'keyModal') {

      await interaction.deferReply({ ephemeral: true });

      const key = interaction.fields.getTextInputValue('keyInput');

      const res = await fetch(`${BACKEND_URL}/usekey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });

      const data = await res.json();

      if (!data.success) {
        return interaction.editReply("Invalid or expired key");
      }

      // SAVE ACTIVE KEY
      activeKeys[interaction.user.id] = {
        key,
        remainingUses: data.remainingUses,
        expiresAt: Date.now() + (60 * 60 * 1000) // fallback 1h
      };

      // UNLOCK CHANNELS FOR USER
      for (let channelId of lockedChannels) {
        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) continue;

        await channel.permissionOverwrites.edit(interaction.user.id, {
          SendMessages: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("✅ Key Activated")
        .setDescription(`Uses left: ${data.remainingUses}`)
        .setColor("Green");

      interaction.editReply({ embeds: [embed] });

      // ===== REALTIME UPDATE =====
      const interval = setInterval(async () => {

        const userKey = activeKeys[interaction.user.id];
        if (!userKey) return clearInterval(interval);

        embed.setDescription(`Uses left: ${userKey.remainingUses}`);

        try {
          await interaction.editReply({ embeds: [embed] });
        } catch {}

      }, 1000);
    }
  }
});

// ===== TRACK MESSAGE USAGE =====
client.on('messageCreate', async message => {

  if (!lockedChannels.has(message.channel.id)) return;
  if (message.author.bot) return;

  const userKey = activeKeys[message.author.id];
  if (!userKey) return;

  userKey.remainingUses--;

  if (userKey.remainingUses <= 0) {

    delete activeKeys[message.author.id];

    // LOCK BACK
    for (let channelId of lockedChannels) {
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel) continue;

      await channel.permissionOverwrites.delete(message.author.id);
    }

    message.reply("🔒 Key expired / used up");
  }
});

// ===== LOGIN =====
client.login(process.env.TOKEN);
