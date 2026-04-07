require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const admin = require('firebase-admin');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

// Firebase Init
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});
const db = admin.database();

// Owner ID
const OWNER_ID = process.env.OWNER_ID;

// Track locked channels
const lockedChannels = new Set();

// Slash commands
const commands = [
    new SlashCommandBuilder().setName('lock').setDescription('Lock a channel').addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock').setRequired(true)),
    new SlashCommandBuilder().setName('unlock').setDescription('Unlock a channel').addChannelOption(opt => opt.setName('channel').setDescription('Channel to unlock').setRequired(true)),
    new SlashCommandBuilder().setName('keyv').setDescription('Verify your key')
].map(cmd => cmd.toJSON());

// Deploy commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log('✅ Commands registered.');
    } catch (err) {
        console.error(err);
    }
})();

// Message listener to reduce key uses
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Check if user has a valid key
    const keySnapshot = await db.ref('keys').orderByChild('redeemer').equalTo(message.author.id).once('value');
    if (!keySnapshot.exists()) return;

    const keyData = Object.entries(keySnapshot.val())[0];
    const key = keyData[0];
    const data = keyData[1];

    if (lockedChannels.has(message.channel.id)) return;

    // Reduce uses
    const newUsed = (data.used || 0) + 1;
    if (newUsed >= data.maxUses) {
        await db.ref(`keys/${key}`).remove();
        message.channel.send(`<@${message.author.id}>, your key has expired.`);
    } else {
        await db.ref(`keys/${key}`).update({ used: newUsed });
    }
});

// Slash command handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    if (interaction.isChatInputCommand()) {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Only owner can use this!", ephemeral: true });

        const channel = interaction.options.getChannel('channel');

        if (interaction.commandName === 'lock') {
            lockedChannels.add(channel.id);
            interaction.reply(`🔒 Locked ${channel}`);
        }

        if (interaction.commandName === 'unlock') {
            lockedChannels.delete(channel.id);
            interaction.reply(`🔓 Unlocked ${channel}`);
        }

        if (interaction.commandName === 'keyv') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('redeem_key').setLabel('Redeem Key').setStyle(ButtonStyle.Primary)
            );
            interaction.reply({ content: 'Click to redeem your key', components: [row], ephemeral: true });
        }
    }

    // Button interaction
    if (interaction.isButton() && interaction.customId === 'redeem_key') {
        // Ask user for key input
        await interaction.reply({ content: 'Please type your key in this channel', ephemeral: true });

        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async m => {
            const key = m.content.trim();

            const ref = db.ref('keys/' + key);
            const snap = await ref.once('value');
            if (!snap.exists()) return interaction.followUp({ content: '❌ Invalid key', ephemeral: true });

            const data = snap.val();
            const now = Date.now();

            if (data.used >= data.maxUses || now > data.expiryRaw) {
                await ref.remove();
                return interaction.followUp({ content: '❌ Key expired or used up', ephemeral: true });
            }

            // Set redeemer and allow unlocking
            await ref.update({ redeemer: interaction.user.id });
            lockedChannels.forEach(chId => interaction.guild.channels.cache.get(chId)?.permissionOverwrites.edit(interaction.user.id, { SendMessages: true }));

            interaction.followUp({ content: `✅ Key valid! Remaining uses: ${data.maxUses - data.used}\nExpires: ${data.expiry}` });
        });
    }
});

client.login(process.env.DISCORD_TOKEN);
