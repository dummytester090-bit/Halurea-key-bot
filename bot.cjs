// bot.cjs

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { REST, Routes } = require('@discordjs/rest');
const admin = require('firebase-admin');
const express = require('express');

// -------------------- Discord Bot Setup --------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

const OWNER_ID = process.env.OWNER_ID;
const KEY_PANEL_CHANNEL_ID = process.env.KEY_PANEL_CHANNEL_ID;

// -------------------- Firebase Setup --------------------
let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// -------------------- Locked Channels --------------------
const lockedChannels = new Set();

// -------------------- Slash Commands --------------------
const { SlashCommandBuilder } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock a channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock').setRequired(true)),
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock a channel')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to unlock').setRequired(true)),
].map(cmd => cmd.toJSON());

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

// -------------------- Persistent Key Panel --------------------
let keyPanelMessage;
const userKeyMessages = new Map(); // Map<userId, Map<key, messageId>>

async function createOrFetchKeyPanel() {
    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
    if (!channel) return console.error("Key panel channel not found!");

    // Check if panel already exists
    const messages = await channel.messages.fetch({ limit: 50 });
    keyPanelMessage = messages.find(m => m.author.id === client.user.id && m.content.includes('Click the button below to redeem your key:'));

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('redeem_key')
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Primary)
    );

    if (!keyPanelMessage) {
        keyPanelMessage = await channel.send({ content: 'Click the button below to redeem your key:', components: [row] });
    } else {
        await keyPanelMessage.edit({ components: [row] });
    }
}

// -------------------- Message Listener for Key Usage --------------------
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const snap = await db.ref('keys').orderByChild('redeemer').equalTo(message.author.id).once('value');
    if (!snap.exists()) return;

    const now = Date.now();

    for (const [key, data] of Object.entries(snap.val())) {
        if (lockedChannels.has(message.channel.id)) continue;

        const newUsed = (data.used || 0) + 1;
        if (newUsed >= data.maxUses || now > data.expiryRaw) {
            await db.ref(`keys/${key}`).remove();
            // Delete corresponding key info message
            if (userKeyMessages.has(message.author.id) && userKeyMessages.get(message.author.id).has(key)) {
                const msgId = userKeyMessages.get(message.author.id).get(key);
                try {
                    const channel = await client.channels.fetch(message.channel.id);
                    const msg = await channel.messages.fetch(msgId);
                    msg.delete().catch(() => {});
                } catch {}
                userKeyMessages.get(message.author.id).delete(key);
            }
            message.channel.send(`<@${message.author.id}>, your key ${key} has expired.`);
        } else {
            await db.ref(`keys/${key}`).update({ used: newUsed });
        }
    }
});

// -------------------- Button Interaction --------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || interaction.customId !== 'redeem_key') return;

    await interaction.reply({ content: 'Please type your key in this channel within 60 seconds.', ephemeral: true });

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

        // Assign redeemer
        await ref.update({ redeemer: interaction.user.id });

        // Unlock channels for this user
        lockedChannels.forEach(chId => {
            const channel = interaction.guild.channels.cache.get(chId);
            if (channel) channel.permissionOverwrites.edit(interaction.user.id, { SendMessages: true });
        });

        // Send key info message
        const infoMsg = await interaction.channel.send(`<@${interaction.user.id}> redeemed key: ${key}\nRemaining uses: ${data.maxUses - (data.used || 0)}\nExpires in: calculating... minutes`);

        if (!userKeyMessages.has(interaction.user.id)) userKeyMessages.set(interaction.user.id, new Map());
        userKeyMessages.get(interaction.user.id).set(key, infoMsg.id);
    });
});

// -------------------- Countdown Update --------------------
setInterval(async () => {
    const now = Date.now();

    for (const [userId, keyMap] of userKeyMessages.entries()) {
        for (const [key, msgId] of keyMap.entries()) {
            const ref = db.ref('keys/' + key);
            const snap = await ref.once('value');
            const data = snap.val();

            if (!data || !data.redeemer) {
                // Key deleted: remove message
                try {
                    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
                    const msg = await channel.messages.fetch(msgId);
                    msg.delete().catch(() => {});
                } catch {}
                keyMap.delete(key);
                continue;
            }

            const remainingMs = data.expiryRaw - now;
            if (remainingMs <= 0) {
                await ref.remove();
                try {
                    const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
                    const msg = await channel.messages.fetch(msgId);
                    msg.delete().catch(() => {});
                } catch {}
                keyMap.delete(key);
                continue;
            }

            const minutesLeft = Math.ceil(remainingMs / 60000);
            try {
                const channel = await client.channels.fetch(KEY_PANEL_CHANNEL_ID);
                const msg = await channel.messages.fetch(msgId);
                msg.edit(`<@${userId}> redeemed key: ${key}\nRemaining uses: ${data.maxUses - (data.used || 0)}\nExpires in: ${minutesLeft} min`);
            } catch {}
        }

        if (keyMap.size === 0) userKeyMessages.delete(userId);
    }
}, 10000); // update every 10 seconds

// -------------------- Slash Commands Handling --------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Only owner can use this!", ephemeral: true });

    const channel = interaction.options.getChannel('channel');

    if (interaction.commandName === 'lock') {
        lockedChannels.add(channel.id);
        // Remove send permission for everyone except users with keys
        channel.permissionOverwrites.set([{ id: interaction.guild.roles.everyone.id, deny: ['SendMessages'] }]);
        interaction.reply(`🔒 Locked ${channel}`);
    }

    if (interaction.commandName === 'unlock') {
        lockedChannels.delete(channel.id);
        channel.permissionOverwrites.set([{ id: interaction.guild.roles.everyone.id, allow: ['SendMessages'] }]);
        interaction.reply(`🔓 Unlocked ${channel}`);
    }
});

// -------------------- Discord Login --------------------
client.login(process.env.DISCORD_TOKEN);

// -------------------- On Ready --------------------
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await createOrFetchKeyPanel();
});

// -------------------- Tiny Express Server for Render --------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
