import { Client, REST, Routes, GatewayIntentBits, ChatInputCommandInteraction, type CacheType } from 'discord.js';
import { SlashCommandBuilder } from '@discordjs/builders';
import ollama from 'ollama';

// Get environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const CLIENT_ID = process.env.CLIENT_ID ?? '';

if (DISCORD_TOKEN === '' || CLIENT_ID === '') {
  console.error('Missing required environment variables');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Define the slash command
const summarizeCommand = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription('Summarize channel messages from a specific time range')
  .addIntegerOption(option =>
    option.setName('hours')
      .setDescription('Hours to look back')
      .setMinValue(0)
      .setMaxValue(24)
      .setRequired(true))
  .addIntegerOption(option =>
    option.setName('minutes')
      .setDescription('Minutes to look back')
      .setMinValue(0)
      .setMaxValue(59)
      .setRequired(true));

// Register slash commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: [summarizeCommand.toJSON()] },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once('ready', () => {
  console.log('Discord bot is ready!');
  registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'summarize') {
    await handleSummarizeCommand(interaction);
  }
});

async function handleSummarizeCommand(interaction) {
  const hours = interaction.options.getInteger('hours');
  const minutes = interaction.options.getInteger('minutes');

  try {
    // Defer reply since this might take a while, make it ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Calculate time range
    const timeRange = new Date();
    timeRange.setHours(timeRange.getHours() - hours);
    timeRange.setMinutes(timeRange.getMinutes() - minutes);

    // Fetch messages
    const messages = await fetchMessagesInTimeRange(interaction.channel, timeRange);
    if (messages.length === 0) {
      await interaction.editReply({ 
        content: 'No messages found in the specified time range.',
        ephemeral: true 
      });
      return;
    }

    // Generate summary using Ollama
    const summary = await generateSummary(messages);
    await interaction.editReply({
      content: `Summary of the last ${hours}h ${minutes}m:\n\n${summary}`,
      ephemeral: true
    });

  } catch (error) {
    console.error('Error generating summary:', error);
    const errorMessage = interaction.deferred
      ? 'Sorry, there was an error generating the summary.'
      : 'An error occurred while processing your request.';
    
    if (interaction.deferred) {
      await interaction.editReply(errorMessage);
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
}

async function fetchMessagesInTimeRange(channel, startTime) {
  const messages = [];
  
  console.log(`Fetching messages after: ${startTime}`);

  try {
    // Fetch all messages from the last 100 messages that are after startTime
    const fetchedMessages = await channel.messages.fetch({ limit: 100 });
    console.log(`Fetched ${fetchedMessages.size} messages`);

    // Filter messages within our time range
    const validMessages = Array.from(fetchedMessages.values())
      .filter(msg => {
        const isAfterStartTime = msg.createdAt > startTime;
        console.log(`Message from ${msg.author.username} at ${msg.createdAt} - Valid: ${isAfterStartTime}`);
        return isAfterStartTime;
      });

    console.log(`Found ${validMessages.length} valid messages`);

    // Add valid messages to our array
    messages.push(...validMessages.map(msg => ({
      author: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt
    })));
  } catch (error) {
    console.error('Error fetching messages:', error);
  }

  return messages;
}

async function generateSummary(messages) {
  // Format messages for the LLM
  const conversation = messages
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(msg => `${msg.author}: ${msg.content}`)
    .join('\n');

  const prompt = `Please provide a concise summary of the following Discord conversation, highlighting the main topics discussed and any important conclusions or decisions made:\n\n${conversation}`;

  try {
    const response = await ollama.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: prompt }],
    });

    return response.message.content;
  } catch (error) {
    console.error('Error calling Ollama:', error);
    throw new Error('Failed to generate summary');
  }
}

// Start the bot
client.login(DISCORD_TOKEN);