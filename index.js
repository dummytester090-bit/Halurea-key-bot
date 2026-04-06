// index.js
const { Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, EmbedBuilder } = require('discord.js');
const { randomBytes } = require('crypto');
const admin = require('firebase-admin');

// -----------------------
// ENV Variables (set in Render dashboard)
// -----------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT; // full JSON string

if (!DISCORD_TOKEN || !FIREBASE_SERVICE_ACCOUNT) {
    console.error("❌ ENV missing DISCORD_TOKEN or FIREBASE_SERVICE_ACCOUNT");
    process.exit(1);
}

// -----------------------
// Firebase init
// -----------------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch (err) {
    console.error("❌ Firebase parsing error:", err);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || "https://halurea1-default-rtdb.asia-southeast1.firebasedatabase.app/"
});

const db = admin.database();

// -----------------------
// Bot init
// -----------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

// -----------------------
// Config
// -----------------------
const OWNER_ID = process.env.OWNER_ID; // you
const hiredUsers = new Set(); // dynamic hire/fire
const lockedChannels = new Set(); // locked channels
const activeRedemptions = new Map(); // userId -> key

// -----------------------
// Helper Functions
// -----------------------
function formatReadableTime(date) {
    return date.toLocaleString('en-US', { 
        month:'short', day:'numeric', year:'numeric', 
        hour:'numeric', minute:'numeric', second:'numeric', hour12:true
    });
}

// Realtime countdown string
function getCountdown(expiry) {
    const now = Date.now();
    const diff = expiry - now;
    if (diff <= 0) return 'Expired';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

// Check if user is authorized
function isAuth(userId) {
    return userId === OWNER_ID || hiredUsers.has(userId);
}

// -----------------------
// Register Commands
// -----------------------
const commands = [
    new SlashCommandBuilder().setName('hire').setDescription('Hire a user').addUserOption(opt => opt.setName('user').setDescription('User to hire').setRequired(true)),
    new SlashCommandBuilder().setName('fire').setDescription('Fire a user').addUserOption(opt => opt.setName('user').setDescription('User to fire').setRequired(true)),
    new SlashCommandBuilder().setName('lock').setDescription('Lock channels').addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock').setRequired(true)),
    new SlashCommandBuilder().setName('keyv').setDescription('Send key redemption message').addChannelOption(opt => opt.setName('channel').setDescription('Channel to send message').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('🔄 Registering commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Commands registered');
    } catch (err) {
        console.error(err);
    }
})();

// -----------------------
// Bot Event
// -----------------------
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

        const userId = interaction.user.id;

        // ------------------- AUTH COMMANDS -------------------
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            // Hire
            if (commandName === 'hire') {
                if (userId !== OWNER_ID) return interaction.reply({ content:'Only owner can hire', ephemeral:true });
                const target = interaction.options.getUser('user');
                hiredUsers.add(target.id);
                return interaction.reply({ content:`✅ Hired ${target.tag}`, ephemeral:true });
            }

            // Fire
            if (commandName === 'fire') {
                if (userId !== OWNER_ID) return interaction.reply({ content:'Only owner can fire', ephemeral:true });
                const target = interaction.options.getUser('user');
                hiredUsers.delete(target.id);
                return interaction.reply({ content:`❌ Fired ${target.tag}`, ephemeral:true });
            }

            // Lock
            if (commandName === 'lock') {
                if (!isAuth(userId)) return interaction.reply({ content:'Not authorized', ephemeral:true });
                const channel = interaction.options.getChannel('channel');
                lockedChannels.add(channel.id);
                return interaction.reply({ content:`🔒 Locked ${channel}`, ephemeral:true });
            }

            // Keyv
            if (commandName === 'keyv') {
                if (!isAuth(userId)) return interaction.reply({ content:'Not authorized', ephemeral:true });
                const channel = interaction.options.getChannel('channel');

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('redeem_key').setLabel('Redeem Key').setStyle(ButtonStyle.Primary)
                );

                return interaction.reply({ content:'Click to redeem key', components:[row], ephemeral:false, fetchReply:true });
            }
        }

        // ------------------- BUTTON -------------------
        if (interaction.isButton()) {
            if (interaction.customId !== 'redeem_key') return;
            const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('Redeem your key');
            const input = new TextInputBuilder().setCustomId('key_input').setLabel('Enter your key').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }

        // ------------------- MODAL -------------------
        if (interaction.type === InteractionType.ModalSubmit) {
            if (interaction.customId !== 'redeem_modal') return;
            const key = interaction.fields.getTextInputValue('key_input');

            if (activeRedemptions.has(userId)) {
                return interaction.reply({ content:'❌ You already have an active key. Wait until it expires.', ephemeral:true });
            }

            const snapshot = await db.ref('keys/' + key).once('value');
            if (!snapshot.exists()) return interaction.reply({ content:'❌ Invalid key', ephemeral:true });

            const data = snapshot.val();
            const expiry = new Date(data.expiry).getTime();
            const now = Date.now();
            if (expiry < now) {
                await db.ref('keys/' + key).remove();
                return interaction.reply({ content:'❌ Key expired', ephemeral:true });
            }

            if (data.used >= data.maxUses) {
                await db.ref('keys/' + key).remove();
                return interaction.reply({ content:'❌ Key fully used', ephemeral:true });
            }

            // Redemption success
            activeRedemptions.set(userId, key);

            // Unlock all locked channels for user
            for (const chanId of lockedChannels) {
                const chan = await client.channels.fetch(chanId);
                chan.permissionOverwrites.edit(userId, { ViewChannel:true, SendMessages:true });
            }

            await db.ref('keys/' + key).update({ used: data.used + 1 });

            // Send embed with realtime info
            const embed = new EmbedBuilder()
                .setTitle('✅ Key Redeemed')
                .addFields(
                    { name:'Key', value:key, inline:false },
                    { name:'Created At', value:data.createdAt, inline:true },
                    { name:'Expiry', value:data.expiry, inline:true },
                    { name:'Uses Left', value:`${data.maxUses - (data.used+1)}`, inline:true }
                )
                .setColor('Green')
                .setTimestamp();

            return interaction.reply({ embeds:[embed], ephemeral:false });
        }

    } catch (err) {
        console.error(err);
    }
});

// -----------------------
// Auto cleanup expired keys & lock channels
// -----------------------
setInterval(async () => {
    try {
        const snapshot = await db.ref('keys').once('value');
        const now = Date.now();
        snapshot.forEach(child => {
            const data = child.val();
            if (!data) return;
            const expiry = new Date(data.expiry).getTime();
            const fullyUsed = data.used >= data.maxUses;
            if (expiry < now || fullyUsed) {
                child.ref.remove();
            }
        });

        // Relock channels if no active redemptions
        if (activeRedemptions.size === 0) {
            for (const chanId of lockedChannels) {
                const chan = await client.channels.fetch(chanId);
                chan.permissionOverwrites.set([]); // reset permissions
            }
        }
    } catch (err) {
        console.error(err);
    }
}, 1000);

// -----------------------
client.login(DISCORD_TOKEN).then(() => console.log('🚀 Bot ready'));
