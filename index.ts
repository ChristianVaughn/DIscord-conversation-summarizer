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

// Define the slash command with more options
const summarizeCommand = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription('Summarize channel messages')
  .addSubcommand(subcommand =>
    subcommand
      .setName('range')
      .setDescription('Summarize messages between two dates/times')
      .addStringOption(option =>
        option.setName('start_date')
          .setDescription('Start date (YYYY-MM-DD)')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('start_hour')
          .setDescription('Start hour (0-23)')
          .setMinValue(0)
          .setMaxValue(23)
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('start_minute')
          .setDescription('Start minute (0-59)')
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(true))
      .addStringOption(option =>
        option.setName('end_date')
          .setDescription('End date (YYYY-MM-DD)')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('end_hour')
          .setDescription('End hour (0-23)')
          .setMinValue(0)
          .setMaxValue(23)
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('end_minute')
          .setDescription('End minute (0-59)')
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(true)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('last')
      .setDescription('Summarize the last X hours/minutes')
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
          .setRequired(true)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('since')
      .setDescription('Summarize messages since a specific time today')
      .addIntegerOption(option =>
        option.setName('hour')
          .setDescription('Hour (0-23)')
          .setMinValue(0)
          .setMaxValue(23)
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('minute')
          .setDescription('Minute (0-59)')
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(true)));

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
  try {
    await interaction.deferReply({ ephemeral: true });

    let startTime, endTime;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'last') {
      const hours = interaction.options.getInteger('hours');
      const minutes = interaction.options.getInteger('minutes');
      startTime = new Date();
      startTime.setHours(startTime.getHours() - hours);
      startTime.setMinutes(startTime.getMinutes() - minutes);
      endTime = new Date();
    } else if (subcommand === 'since') {
      const hour = interaction.options.getInteger('hour');
      const minute = interaction.options.getInteger('minute');
      startTime = new Date();
      startTime.setHours(hour, minute, 0, 0);
      endTime = new Date();
    } else if (subcommand === 'range') {
      // Parse start date/time
      const startDate = interaction.options.getString('start_date');
      const startHour = interaction.options.getInteger('start_hour');
      const startMinute = interaction.options.getInteger('start_minute');
      
      // Parse end date/time
      const endDate = interaction.options.getString('end_date');
      const endHour = interaction.options.getInteger('end_hour');
      const endMinute = interaction.options.getInteger('end_minute');
      
      try {
        startTime = new Date(`${startDate}T${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}:00`);
        endTime = new Date(`${endDate}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00`);
        
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
          throw new Error('Invalid date format');
        }
        
        if (endTime < startTime) {
          await interaction.editReply({
            content: 'End time must be after start time.',
            ephemeral: true
          });
          return;
        }
      } catch (error) {
        await interaction.editReply({
          content: 'Invalid date format. Please use YYYY-MM-DD for dates.',
          ephemeral: true
        });
        return;
      }
    }

    console.log(`Fetching messages between ${startTime} and ${endTime}`);
    const messages = await fetchMessagesInTimeRange(interaction.channel, startTime, endTime);
    
    if (messages.length === 0) {
      await interaction.editReply({
        content: 'No messages found in the specified time range.',
        ephemeral: true
      });
      return;
    }

    const summary = await generateSummary(messages);
    let timeDescription;
    if (subcommand === 'last') {
      timeDescription = `the last ${interaction.options.getInteger('hours')}h ${interaction.options.getInteger('minutes')}m`;
    } else if (subcommand === 'since') {
      timeDescription = `${interaction.options.getInteger('hour')}:${String(interaction.options.getInteger('minute')).padStart(2, '0')}`;
    } else if (subcommand === 'range') {
      const startDate = interaction.options.getString('start_date');
      const endDate = interaction.options.getString('end_date');
      timeDescription = `${startDate} ${interaction.options.getInteger('start_hour')}:${String(interaction.options.getInteger('start_minute')).padStart(2, '0')} to ${endDate} ${interaction.options.getInteger('end_hour')}:${String(interaction.options.getInteger('end_minute')).padStart(2, '0')}`;
    }

    await interaction.editReply({
      content: `Summary since ${timeDescription}:\n\n${summary}`,
      ephemeral: true
    });

  } catch (error) {
    console.error('Error generating summary:', error);
    const errorMessage = 'Sorry, there was an error generating the summary.';
    await interaction.editReply({ content: errorMessage, ephemeral: true });
  }
}

async function fetchMessagesInTimeRange(channel, startTime, endTime = new Date()) {
  const messages = [];
  let lastId;

  try {
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const fetchedMessages = await channel.messages.fetch(options);
      console.log(`Fetched batch of ${fetchedMessages.size} messages`);
      
      if (fetchedMessages.size === 0) break;

      const validMessages = Array.from(fetchedMessages.values()).filter(msg => {
        const isInRange = msg.createdAt > startTime && msg.createdAt <= endTime;
        console.log(`Message from ${msg.author.username} at ${msg.createdAt} - Valid: ${isInRange}`);
        return isInRange;
      });

      if (validMessages.length === 0 && fetchedMessages.last().createdAt < startTime) {
        console.log('Reached messages before start time, stopping fetch');
        break;
      }

      messages.push(...validMessages.map(msg => ({
        author: msg.author.username,
        content: msg.content,
        timestamp: msg.createdAt
      })));

      lastId = fetchedMessages.last().id;
    }
  } catch (error) {
    console.error('Error fetching messages:', error);
  }

  console.log(`Total valid messages found: ${messages.length}`);
  return messages;
}

async function generateSummary(messages) {
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

client.login(DISCORD_TOKEN);