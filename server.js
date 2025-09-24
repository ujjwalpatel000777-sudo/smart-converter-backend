const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { Paddle } = require('@paddle/paddle-node-sdk');
const OpenAI = require('openai');


require('dotenv').config();
const port = process.env.PORT || 3001;


const app = express();

const paddle = new Paddle(process.env.PADDLE_API_KEY);


// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
// const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE
const supabase = createClient(supabaseUrl, supabaseServiceRole);



// Initialize OpenAI client for GPT-5 Mini
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(cors());

// Enhanced webhook endpoint
app.post('/api/webhooks/paddle', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    console.log('=== PADDLE WEBHOOK REQUEST RECEIVED ===');
    console.log('Headers:', req.headers);
    console.log('Body type:', typeof req.body);
    console.log('Body length:', req.body.length);

    const signature = req.headers['paddle-signature'];
    const rawRequestBody = req.body.toString();
    const secretKey = process.env.PADDLE_WEBHOOK_SECRET;

    console.log('Paddle signature:', signature);

    if (!signature || !rawRequestBody) {
      console.log('ERROR: Signature or request body missing');
      return res.status(400).json({ error: 'Invalid webhook request' });
    }

    // Verify webhook signature using Paddle SDK
    console.log('Verifying webhook signature...');
    const eventData = await paddle.webhooks.unmarshal(rawRequestBody, secretKey, signature);
    
    console.log('Webhook signature verification successful');
    console.log('=== PADDLE WEBHOOK EVENT DETAILS ===');
    console.log('Event type:', eventData.eventType);
    console.log('Event data:', JSON.stringify(eventData.data, null, 2));

    // Handle different event types
    switch (eventData.eventType) {
      case 'subscription.created':
      case 'subscription.activated':
        console.log('Processing subscription created/activated event');
        await handleSubscriptionActivated(eventData.data);
        break;
        
      case 'subscription.updated':
        console.log('Processing subscription updated event');
        await handleSubscriptionUpdated(eventData.data);
        break;

      case 'subscription.past_due':
        console.log('Processing subscription past due event');
        await handleSubscriptionPastDue(eventData.data);
        break;

      case 'subscription.canceled':
        console.log('Processing subscription cancelled event');
        await handleSubscriptionCancelled(eventData.data);
        break;
        
      case 'subscription.paused':
        console.log('Processing subscription paused event');
        await handleSubscriptionPaused(eventData.data);
        break;
        
      case 'subscription.resumed':
        console.log('Processing subscription resumed event');
        await handleSubscriptionResumed(eventData.data);
        break;

      default:
        console.log('Unhandled event type:', eventData.eventType);
    }

    console.log('=== PADDLE WEBHOOK PROCESSING SUCCESSFUL ===');
    res.status(200).json({ received: true });

  } catch (error) {
    console.log('=== PADDLE WEBHOOK ERROR ===');
    console.log('Full error object:', JSON.stringify(error, null, 2));
    console.log('Error name:', error.name);
    console.log('Error message:', error.message);
    console.log('Error stack:', error.stack);
    console.log('Request body (raw):', req.body);
    
    res.status(400).json({ error: 'Webhook failed' });
  }
});


app.use(express.json({ limit: '50mb' })); // Increase limit for large code files
app.use(express.urlencoded({ extended: true, limit: '50mb' }));



// Helper function to hash API key (unchanged)
async function hashApiKey(apiKey) {
  const saltRounds = 12;
  return await bcrypt.hash(apiKey, saltRounds);
}

// Helper function to verify API key (unchanged)
async function verifyApiKey(plainApiKey, hashedApiKey) {
  return await bcrypt.compare(plainApiKey, hashedApiKey);
}

// Helper function to find API key by comparing with all hashed keys (unchanged)
async function findApiKeyRecord(plainApiKey) {
  // Get all API key records
  const { data: allApiKeys, error } = await supabase
    .from('api_keys')
    .select(`
      name,
      api_key,
      count,
      last_reset_date,
      users!inner(plan)
    `)
    .not('api_key', 'is', null);

  if (error) {
    throw error;
  }

  // Check each hashed API key
  for (const record of allApiKeys) {
    const isMatch = await verifyApiKey(plainApiKey, record.api_key);
    if (isMatch) {
      return record;
    }
  }

  return null;
}

async function handleSubscriptionActivated(subscription) {
  console.log('=== HANDLING SUBSCRIPTION ACTIVATED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  const userName = subscription.customData?.userName;
  const email = subscription.customData?.email;

  if (!userName && !email) {
    console.log('ERROR: No user identifier found in subscription data');
    return;
  }

  // Find user by userName first, then by email as fallback
  let userQuery = supabase.from('users').select('name');
  if (userName) {
    userQuery = userQuery.eq('name', userName);
  } else {
    userQuery = userQuery.eq('email', email);
  }

  const { data: user, error: userError } = await userQuery.single();

  if (userError || !user) {
    console.log('ERROR: User not found for subscription activation');
    console.log('User lookup error:', JSON.stringify(userError, null, 2));
    return;
  }

  // Update user to pro plan
  const { error: updateError } = await supabase
    .from('users')
    .update({ 
      plan: 'pro',
      subscription_status: 'active',
      subscription_id: subscription.id
    })
    .eq('name', user.name);

  if (updateError) {
    console.log('ERROR: Failed to activate subscription in database');
    console.log('Database error:', JSON.stringify(updateError, null, 2));
    return;
  }

  // Reset count to 0 for newly activated pro users
  const { error: countError } = await supabase
    .from('api_keys')
    .update({ 
      count: 0,
      last_reset_date: new Date().toISOString().split('T')[0]
    })
    .eq('name', user.name);

  if (countError) {
    console.log('ERROR: Failed to reset count for activated user');
    console.log('Count error:', JSON.stringify(countError, null, 2));
  } else {
    console.log('SUCCESS: Count reset to 0 for activated pro user');
  }

  console.log('SUCCESS: Subscription activated for user:', user.name);
}
async function handleSubscriptionPastDue(subscription) {
  console.log('=== HANDLING SUBSCRIPTION PAST DUE ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Get the user name first
  const { data: user, error: getUserError } = await supabase
    .from('users')
    .select('name')
    .eq('subscription_id', subscription.id)
    .single();

  if (getUserError) {
    console.log('ERROR: Failed to get user for past due handling');
    return;
  }

  // Update user plan to free
  const { error: userError } = await supabase
    .from('users')
    .update({ 
      plan: 'free',
      subscription_status: 'past_due'
    })
    .eq('subscription_id', subscription.id);

  if (userError) {
    console.log('ERROR: Failed to handle past due subscription in database');
    console.log('Database error:', JSON.stringify(userError, null, 2));
    return;
  }

  // Set count to 3 (used all free requests) for past due users
  const { error: countError } = await supabase
    .from('api_keys')
    .update({ 
      count: 3,
      last_reset_date: new Date().toISOString().split('T')[0]
    })
    .eq('name', user.name);

  if (countError) {
    console.log('ERROR: Failed to set count to 3 for past due user');
    console.log('Count error:', JSON.stringify(countError, null, 2));
  } else {
    console.log('SUCCESS: Count set to 3 for past due user (no free requests remaining)');
  }

  console.log('SUCCESS: Subscription marked as past due and downgraded to free for subscription:', subscription.id);
}

async function handleSubscriptionUpdated(subscription) {
  console.log('=== HANDLING SUBSCRIPTION UPDATED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Check if subscription has a scheduled change to cancel
  if (subscription.scheduledChange && subscription.scheduledChange.action === 'cancel') {
    console.log('Subscription has scheduled cancellation');
    
    const { error } = await supabase
      .from('users')
      .update({ 
        subscription_status: 'cancel_at_period_end'
      })
      .eq('subscription_id', subscription.id);
     
    if (error) {
      console.log('ERROR: Failed to update subscription status to cancel_at_period_end');
      console.log('Database error:', JSON.stringify(error, null, 2));
    } else {
      console.log('SUCCESS: Subscription marked as cancel_at_period_end for subscription:', subscription.id);
    }
  } else if (subscription.status === 'active' && !subscription.scheduledChange) {
    // Subscription is active with no scheduled changes (cancellation was removed)
    console.log('Subscription is active with no scheduled changes - reactivating');
    
    const { error } = await supabase
      .from('users')
      .update({ 
        subscription_status: 'active'
      })
      .eq('subscription_id', subscription.id);
     
    if (error) {
      console.log('ERROR: Failed to reactivate subscription status');
      console.log('Database error:', JSON.stringify(error, null, 2));
    } else {
      console.log('SUCCESS: Subscription reactivated for subscription:', subscription.id);
    }
  } else {
    console.log('No status update needed for subscription:', subscription.id);
    console.log('Current status:', subscription.status);
    console.log('Scheduled change:', subscription.scheduledChange);
  }
}
async function handleSubscriptionCancelled(subscription) {
  console.log('=== HANDLING SUBSCRIPTION CANCELLED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Get the user name first
  const { data: user, error: getUserError } = await supabase
    .from('users')
    .select('name')
    .eq('subscription_id', subscription.id)
    .single();

  if (getUserError) {
    console.log('ERROR: Failed to get user for cancellation');
    return;
  }

  // Update user plan to free
  const { error: userError } = await supabase
    .from('users')
    .update({ 
      plan: 'free',
      subscription_status: 'cancelled'
    })
    .eq('subscription_id', subscription.id);

  if (userError) {
    console.log('ERROR: Failed to cancel subscription in database');
    console.log('Database error:', JSON.stringify(userError, null, 2));
    return;
  }

  // Reset count to 0 for cancelled users (give them 3 fresh free requests)
  const { error: countError } = await supabase
    .from('api_keys')
    .update({ 
      count: 0,
      last_reset_date: new Date().toISOString().split('T')[0]
    })
    .eq('name', user.name);

  if (countError) {
    console.log('ERROR: Failed to reset count for cancelled user');
    console.log('Count error:', JSON.stringify(countError, null, 2));
  } else {
    console.log('SUCCESS: Count reset to 0 for cancelled user (3 free requests available)');
  }

  console.log('SUCCESS: Subscription cancelled and downgraded to free for subscription:', subscription.id);
}

async function handleSubscriptionPaused(subscription) {
  console.log('=== HANDLING SUBSCRIPTION PAUSED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Get the user name first
  const { data: user, error: getUserError } = await supabase
    .from('users')
    .select('name')
    .eq('subscription_id', subscription.id)
    .single();

  if (getUserError) {
    console.log('ERROR: Failed to get user for paused handling');
    return;
  }

  // Update user plan to free
  const { error: userError } = await supabase
    .from('users')
    .update({ 
      plan: 'free',
      subscription_status: 'paused'
    })
    .eq('subscription_id', subscription.id);

  if (userError) {
    console.log('ERROR: Failed to pause subscription in database');
    console.log('Database error:', JSON.stringify(userError, null, 2));
    return;
  }

  // Set count to 3 (used all free requests) for paused users
  const { error: countError } = await supabase
    .from('api_keys')
    .update({ 
      count: 3,
      last_reset_date: new Date().toISOString().split('T')[0]
    })
    .eq('name', user.name);

  if (countError) {
    console.log('ERROR: Failed to set count to 3 for paused user');
    console.log('Count error:', JSON.stringify(countError, null, 2));
  } else {
    console.log('SUCCESS: Count set to 3 for paused user (no free requests remaining)');
  }

  console.log('SUCCESS: Subscription paused for subscription:', subscription.id);
}

async function handleSubscriptionResumed(subscription) {
  console.log('=== HANDLING SUBSCRIPTION RESUMED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Get the user name first
  const { data: user, error: getUserError } = await supabase
    .from('users')
    .select('name')
    .eq('subscription_id', subscription.id)
    .single();

  if (getUserError) {
    console.log('ERROR: Failed to get user for resume handling');
    return;
  }

  // Update user plan to pro
  const { error: userError } = await supabase
    .from('users')
    .update({ 
      plan: 'pro',
      subscription_status: 'active'
    })
    .eq('subscription_id', subscription.id);

  if (userError) {
    console.log('ERROR: Failed to resume subscription in database');
    console.log('Database error:', JSON.stringify(userError, null, 2));
    return;
  }

  // Reset count to 0 for resumed pro users (fresh daily limit)
  const { error: countError } = await supabase
    .from('api_keys')
    .update({ 
      count: 0,
      last_reset_date: new Date().toISOString().split('T')[0]
    })
    .eq('name', user.name);

  if (countError) {
    console.log('ERROR: Failed to reset count for resumed user');
    console.log('Count error:', JSON.stringify(countError, null, 2));
  } else {
    console.log('SUCCESS: Count reset to 0 for resumed pro user');
  }

  console.log('SUCCESS: Subscription resumed for subscription:', subscription.id);
}

function setupSSEHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
}

function sendSSEMessage(res, type, data) {
  res.write(`data: ${JSON.stringify({ 
    type, 
    ...data,
    timestamp: new Date().toISOString()
  })}\n\n`);
}

function endSSE(res) {
  res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
  res.end();
}

async function validateAndProcessRequest(req, res, requiredFields = []) {
  const { api_key, selectedModel, userApiKey } = req.body;
  
  // Setup SSE headers
  setupSSEHeaders(res);
  sendSSEMessage(res, 'connected', { message: 'Stream connected successfully' });

  // API key validation
  if (!api_key || typeof api_key !== 'string' || api_key.trim() === '') {
    sendSSEMessage(res, 'error', { error: 'API key is required and must be a valid string' });
    endSSE(res);
    return null;
  }

  // Validate selectedModel
  if (!selectedModel || typeof selectedModel !== 'string') {
    sendSSEMessage(res, 'error', { error: 'selectedModel is required and must be a valid string' });
    endSSE(res);
    return null;
  }

  // Validate required fields
  for (const field of requiredFields) {
    if (!req.body[field]) {
      sendSSEMessage(res, 'error', { error: `${field} is required` });
      endSSE(res);
      return null;
    }
  }

  const apiKey = api_key.trim();
  sendSSEMessage(res, 'status', { message: 'Validating API key...' });

  // Find the API key and associated user
  const apiKeyData = await findApiKeyRecord(apiKey);
  
  if (!apiKeyData) {
    sendSSEMessage(res, 'error', { error: 'Invalid API key' });
    endSSE(res);
    return null;
  }

  // Model access validation based on plan
  if (selectedModel === 'gpt5-mini' && apiKeyData.users.plan === 'free') {
    sendSSEMessage(res, 'error', { 
      error: 'GPT-5 Mini is only available for Pro plan users. Free users can use DeepSeek R1 or Qwen3 Coder.',
      data: {
        currentPlan: 'free',
        availableModels: ['deepseek-r1', 'qwen3-coder'],
        proModels: ['gpt5-mini']
      }
    });
    endSSE(res);
    return null;
  }

  // For free users using DeepSeek or Qwen models, require their OpenRouter API key
  if (apiKeyData.users.plan === 'free' && 
      (selectedModel === 'deepseek-r1' || selectedModel === 'qwen3-coder')) {
    if (!userApiKey || typeof userApiKey !== 'string' || userApiKey.trim() === '') {
      sendSSEMessage(res, 'error', { 
        error: 'Free users must provide their OpenRouter API key to use DeepSeek R1 or Qwen3 Coder models.',
        data: {
          currentPlan: 'free',
          requiredField: 'userApiKey',
          message: 'Please provide your OpenRouter API key in the userApiKey field'
        }
      });
      endSSE(res);
      return null;
    }
  }

  sendSSEMessage(res, 'status', { message: 'Checking usage limits...' });

  // Use the PostgreSQL function for count management
  const { data: countResult, error: countError } = await supabase
    .rpc('increment_api_count', {
      api_name: apiKeyData.name
    });

  if (countError) {
    throw countError;
  }

  // Check if the function indicates limit reached
  if (!countResult.success) {
    sendSSEMessage(res, 'error', {
      error: countResult.error,
      data: {
        count: countResult.count,
        limit: countResult.limit,
        remaining: countResult.limit - countResult.count,
        plan: apiKeyData.users.plan
      }
    });
    endSSE(res);
    return null;
  }

  return {
    apiKeyData,
    countResult,
    selectedModel,
    userApiKey: userApiKey?.trim() // Pass user's API key if provided
  };
}

async function callAIModel(prompt, model, res, userPlan = 'pro', userApiKey = null) {
  if (model === 'deepseek-r1') {
    const actualModel = "deepseek/deepseek-r1:free";
    
    if (userPlan === 'free') {
      // Free users: use their provided API key
      if (!userApiKey) {
        throw new Error('User API key is required for free users');
      }
      
      console.log('Using user-provided API key for free user');
      const userClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: userApiKey,
      });
      
      try {
        const completion = await userClient.chat.completions.create({
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: 'You are an expert software development assistant. Always return valid JSON responses as requested.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.0,
          stream: true
        });

        let fullResponse = '';
        for await (const chunk of completion) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            sendSSEMessage(res, 'chunk', { content });
          }
        }

        console.log('API call successful with user-provided key');
        return fullResponse;

      } catch (error) {
        console.log('API call failed with user-provided key:', error.message);
        throw new Error(`DeepSeek API call failed with your API key: ${error.message}`);
      }
    } else {
      // Pro users shouldn't use DeepSeek - they have GPT-5 Mini
      throw new Error('Pro users should use GPT-5 Mini model');
    }
    
  } else if (model === 'qwen3-coder') {
    const actualModel = "qwen/qwen3-coder:free";
    
    if (userPlan === 'free') {
      // Free users: use their provided API key
      if (!userApiKey) {
        throw new Error('User API key is required for free users');
      }
      
      console.log('Using user-provided API key for Qwen3 Coder (free user)');
      const userClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: userApiKey,
      });
      
      try {
        const completion = await userClient.chat.completions.create({
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: 'You are an expert software development assistant. Always return valid JSON responses as requested.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.0,
          stream: true
        });

        let fullResponse = '';
        for await (const chunk of completion) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            sendSSEMessage(res, 'chunk', { content });
          }
        }

        console.log('Qwen3 Coder API call successful with user-provided key');
        return fullResponse;

      } catch (error) {
        console.log('Qwen3 Coder API call failed with user-provided key:', error.message);
        throw new Error(`Qwen3 Coder API call failed with your API key: ${error.message}`);
      }
    } else {
      // Pro users shouldn't use Qwen3 Coder - they have GPT-5 Mini
      throw new Error('Pro users should use GPT-5 Mini model');
    }
    
  } else if (model === 'gpt5-mini') {
    // Only for Pro users
    if (userPlan === 'free') {
      throw new Error('GPT-5 Mini is only available for Pro users');
    }
    
    try {
      console.log('Attempting API call with OpenAI GPT-5 Mini');
      
      const completion = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [
          {
            role: 'system',
            content: 'You are an expert software development assistant. Always return valid JSON responses as requested.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: true
      });

      let fullResponse = '';
      for await (const chunk of completion) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          sendSSEMessage(res, 'chunk', { content });
        }
      }

      console.log('OpenAI GPT-5 Mini API call successful');
      return fullResponse;

    } catch (error) {
      console.log('OpenAI GPT-5 Mini API call failed:', error.message);
      throw error;
    }
  } else {
    throw new Error(`Unsupported model: ${model}. Available models: deepseek-r1, qwen3-coder (free), gpt5-mini (pro)`);
  }
}

function parseAIResponse(aiResponse) {
  try {
    let jsonContent = '';
    
    // Strategy 1: Look for JSON block between ```json and ```
    const codeBlockMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonContent = codeBlockMatch[1].trim();
    }
    
    // Strategy 2: Look for JSON object starting with { and ending with }
    if (!jsonContent) {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonContent = jsonMatch[0];
      }
    }
    
    // Strategy 3: Try to clean the response and extract JSON
    if (!jsonContent) {
      let cleaned = aiResponse
        .replace(/^[\s\S]*?(?=\{)/, '')
        .replace(/\}[\s\S]*$/, '}')
        .trim();
      
      if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
        jsonContent = cleaned;
      }
    }
    
    if (jsonContent) {
      return JSON.parse(jsonContent);
    } else {
      throw new Error('No valid JSON found in AI response');
    }
    
  } catch (parseError) {
    // Try fallback parsing
    try {
      let fixedJson = aiResponse
        .replace(/^[\s\S]*?(\{)/, '$1')
        .replace(/(\})[\s\S]*$/, '$1')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .trim();
      
      return JSON.parse(fixedJson);
    } catch (fallbackError) {
      throw new Error(`Failed to parse AI response: ${parseError.message}`);
    }
  }
}

// ====================
// PROMPT CREATION FUNCTIONS
// ====================

function createRefactoringPrompt(projectType, files, projectLanguage, packageJson, allFilesMetadata) {
  const fileExtension = projectLanguage === 'TypeScript' ? '.ts/.tsx' : '.js/.jsx';
  
  return `You are an expert software refactoring assistant. You will COMPLETELY REWRITE all provided files with improved code.

  **IMPORTANT PROJECT SETTINGS:**
  - Project Type: ${projectType}
  - Language: ${projectLanguage}
  - Use ${fileExtension} file extensions
  - Follow ${projectLanguage} best practices and syntax
  
  **PACKAGE.JSON ANALYSIS:**
  Current package.json content:
  ${JSON.stringify(packageJson, null, 2)}
  
  **UNUSED PACKAGE DETECTION INSTRUCTIONS:**
  Analyze all provided code files against the package.json dependencies and devDependencies to identify unused packages.
  
  **ESSENTIAL PACKAGES TO NEVER REMOVE (even if seemingly unused):**
  - react, react-dom, @types/react, @types/react-dom (React core)
  - next, @types/next (Next.js framework)
  - typescript (TypeScript compiler)
  - eslint, @typescript-eslint/*, eslint-* (linting)
  - prettier (code formatting)
  - tailwindcss, autoprefixer, postcss (CSS processing)
  - webpack, @babel/*, babel-* (build tools)
  - jest, @testing-library/*, @types/jest (testing frameworks)
  - @types/node (Node.js types)
  - turbo, lerna (monorepo tools)
  - husky, lint-staged (git hooks)
  
  **PROJECT METADATA ANALYSIS:**
  Complete project metadata for reference:
  ${JSON.stringify(allFilesMetadata, null, 2)}

  **SECURITY ANALYSIS - EXTRACT HARDCODED SECRETS:**
  Analyze all code files and identify any hardcoded secrets, API keys, tokens, or sensitive data.
  
  **COMPLETE REWRITE INSTRUCTIONS:**
  🔄 **TOTAL REPLACEMENT APPROACH:**
  - All provided files will be DELETED and RECREATED from scratch
  - You must provide COMPLETE, WORKING code for every file
  - Maintain ALL existing functionality while improving code quality
  - Replace ALL hardcoded secrets with process.env variables
  
  **ORIGINAL FILES TO COMPLETELY REWRITE:**
  ${JSON.stringify({ files }, null, 2)}
  
  **RESPONSE FORMAT (CRITICAL - MUST BE EXACT JSON):**
  
  {
    "projectType": "${projectType}",
    "language": "${projectLanguage}",
    "timestamp": "ISO_DATE_STRING",
    "totalFiles": number,
    "totalWords": number,
    "changes_summary": "Comprehensive description of all improvements made",
    "secrets": {
      "API_KEY": "actual-hardcoded-value-found"
    },
    "packageAnalysis": {
      "totalDependencies": number,
      "totalDevDependencies": number,
      "unusedPackagesFound": number,
      "essentialPackagesKept": number
    },
    "unusedPackages": [
      {
        "name": "package-name-1",
        "type": "dependency",
        "reason": "Not imported or used anywhere in the codebase"
      }
    ],
    "npmUninstallCommands": [
      "npm uninstall package-name-1 package-name-2"
    ],
    "originalFilesToDelete": [
      ${files.map(f => `"${f.path}"`).join(',\n      ')}
    ],
    "files": [
      {
        "path": "relative/path/to/file${fileExtension}",
        "content": "COMPLETE_REWRITTEN_CODE_CONTENT",
        "isNew": true_if_new_file_false_if_replacing_original,
        "isRewritten": true_for_completely_rewritten_files,
        "changes": "Detailed description of improvements made to this file"
      }
    ],
    "additionalFilesToDelete": [
      "any/other/obsolete/files.js"
    ]
  }
  
  **CRITICAL SUCCESS REQUIREMENTS:**
  ✅ ALL files must contain COMPLETE, WORKING, PRODUCTION-READY code
  ✅ ZERO placeholders, TODO comments, or incomplete functions
  ✅ ALL functionality from original files must be preserved
  ✅ Response must be valid JSON with exact structure above`;
}

function createCustomGenerationPrompt(projectType, files, projectLanguage, userPrompt, allFilesMetadata, packageJson) {
  const fileExtension = projectLanguage === 'TypeScript' ? '.ts/.tsx' : '.js/.jsx';
  
  return `You are an expert software development assistant. Generate completely NEW files based on user requirements.

**PROJECT SETTINGS:**
- Type: ${projectType}
- Language: ${projectLanguage}
- Extensions: ${fileExtension}

**PACKAGE.JSON:**
${JSON.stringify(packageJson, null, 2)}

**PROJECT METADATA:**
${JSON.stringify(allFilesMetadata, null, 2)}

**EXISTING FILES FOR CONTEXT:**
${JSON.stringify(files, null, 2)}

**USER REQUIREMENTS:**
${userPrompt}

**CRITICAL FILE HANDLING INSTRUCTIONS:**
1. **Modified Files**: If user asks to modify/rewrite a file, include it with isRewritten: true and complete code
2. **New Files**: If creating new files, include them with isNew: true and complete code  
3. **Unchanged Files**: List all existing files you're NOT modifying in the "unchangedFiles" array

**RESPONSE FORMAT:**
{
  "projectType": "${projectType}",
  "language": "${projectLanguage}",
  "timestamp": "ISO_DATE_STRING",
  "totalFiles": number,
  "totalWords": number,
  "changes_summary": "Description of generated/modified files and functionality",
  "secrets": {
    "API_KEY_NAME": "put-your-key-here"
  },
  "npmInstallCommands": [
    "npm install package-name-1 package-name-2"
  ],
  "originalFilesToDelete": [
    "path/to/file/being/rewritten.js"
  ],
  "unchangedFiles": [
    "path/to/file/not/modified.js"
  ],
  "files": [
    {
      "path": "relative/path/to/file${fileExtension}",
      "content": "COMPLETE_WORKING_CODE",
      "isNew": true,
      "isRewritten": false,
      "changes": "Description of what this file does"
    }
  ]
}

**REQUIREMENTS:**
✅ Complete working code only
✅ No placeholders or TODOs
✅ Use environment variables for secrets
✅ Follow existing project patterns`;
}

function createOptimizationPrompt(projectType, projectLanguage, files) {
  const fileExtension = projectLanguage === 'TypeScript' ? '.ts/.tsx' : '.js/.jsx';
  
  return `You are an expert code optimization specialist. Optimize the provided files for better performance, maintainability, and modern best practices.

**PROJECT SETTINGS:**
- Type: ${projectType}
- Language: ${projectLanguage}
- Extensions: ${fileExtension}

**FILES TO OPTIMIZE:**
${JSON.stringify(files, null, 2)}

**OPTIMIZATION FOCUS:**
1. **Performance**: Improve speed, reduce memory usage, optimize algorithms
2. **Code Quality**: Better structure, error handling, readability
3. **Modern Practices**: Latest syntax, async patterns, security
4. **Maintainability**: Clean code, proper documentation, type safety
5. **Clean Imports**: Remove unused imports and dead code

**RETURN JSON:**
{
  "projectType": "${projectType}",
  "language": "${projectLanguage}",
  "timestamp": "ISO_DATE_STRING",
  "totalFilesOptimized": number,
  "optimization_summary": "Brief description of main optimizations made",
  "files": [
    {
      "path": "file/path${fileExtension}",
      "content": "COMPLETE_OPTIMIZED_CODE",
      "improvements": ["key improvement 1", "key improvement 2"],
      "performanceGains": "brief performance improvement description"
    }
  ],
  "recommendations": ["recommendation 1", "recommendation 2"]
}

**REQUIREMENTS:**
✅ Complete working code only
✅ Preserve all functionality  
✅ Valid ${projectLanguage} syntax
✅ No placeholders or TODOs
✅ Remove unused imports`;
}

// ====================
// MAIN ROUTE HANDLERS
// ====================
// UPDATED /api/process-code route

app.post('/api/process-code', async (req, res) => {
  try {
    const { projectType, files, projectLanguage, packageJson, allFilesMetadata } = req.body;
    
    const validationResult = await validateAndProcessRequest(req, res, [
      'projectType', 'files', 'projectLanguage', 'packageJson'
    ]);
    
    if (!validationResult) return;
    
    const { apiKeyData, countResult, selectedModel, userApiKey } = validationResult;

    // Validation for files
    if (!files || !Array.isArray(files) || files.length === 0) {
      sendSSEMessage(res, 'error', { error: 'Invalid input: files array is required and cannot be empty' });
      endSSE(res);
      return;
    }

    // Validation for packageJson
    if (!packageJson || typeof packageJson !== 'object') {
      sendSSEMessage(res, 'error', { error: 'Invalid input: packageJson is required and must be an object' });
      endSSE(res);
      return;
    }

    sendSSEMessage(res, 'status', { message: 'Creating refactoring prompt...' });
    
    const prompt = createRefactoringPrompt(projectType, files, projectLanguage, packageJson, allFilesMetadata);

    sendSSEMessage(res, 'status', { message: 'Starting AI processing with streaming...' });
    
    // UPDATED: Pass user plan and API key to callAIModel
    const aiResponse = await callAIModel(
      prompt, 
      selectedModel, 
      res, 
      apiKeyData.users.plan, 
      userApiKey
    );

    sendSSEMessage(res, 'status', { message: 'AI processing completed. Parsing response...' });

    const parsedResponse = parseAIResponse(aiResponse);

    // Validate required fields
    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      parsedResponse.files = [];
    }

    sendSSEMessage(res, 'final', {
      success: true,
      data: {
        ...parsedResponse,
        replacementMode: true,
        originalFilesProcessed: files.length,
        usage: {
          count: countResult.count,
          limit: countResult.limit,
          remaining: countResult.remaining,
          plan: apiKeyData.users.plan
        }
      },
      metadata: {
        originalProjectType: projectType,
        projectLanguage: projectLanguage,
        processingTime: new Date().toISOString(),
        replacementMode: true,
        apiKeyUser: apiKeyData.name,
        selectedModel: selectedModel
      }
    });

    sendSSEMessage(res, 'complete', { message: 'Processing completed successfully' });
    endSSE(res);

  } catch (error) {
    console.error('Error in complete replacement mode:', error);
    sendSSEMessage(res, 'error', {
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    endSSE(res);
  }
});

// UPDATED /api/generate-custom route
app.post('/api/generate-custom', async (req, res) => {
  try {
    const { projectType, files, projectLanguage, userPrompt, allFilesMetadata, packageJson } = req.body;
    
    const validationResult = await validateAndProcessRequest(req, res, [
      'projectType', 'projectLanguage', 'userPrompt', 'packageJson'
    ]);
    
    if (!validationResult) return;
    
    const { apiKeyData, countResult, selectedModel, userApiKey } = validationResult;

    // Validate userPrompt
    if (!userPrompt || typeof userPrompt !== 'string' || userPrompt.trim() === '') {
      sendSSEMessage(res, 'error', { error: 'User prompt is required and must be a valid string' });
      endSSE(res);
      return;
    }

    // Validation for packageJson
    if (!packageJson || typeof packageJson !== 'object') {
      sendSSEMessage(res, 'error', { error: 'Invalid input: packageJson is required and must be an object' });
      endSSE(res);
      return;
    }

    sendSSEMessage(res, 'status', { message: 'Creating custom generation prompt...' });
    
    const prompt = createCustomGenerationPrompt(
      projectType, 
      files || [], 
      projectLanguage, 
      userPrompt.trim(),
      allFilesMetadata || {},
      packageJson
    );

    sendSSEMessage(res, 'status', { message: 'Starting AI processing with streaming...' });
    
    // UPDATED: Pass user plan and API key to callAIModel
    const aiResponse = await callAIModel(
      prompt, 
      selectedModel, 
      res, 
      apiKeyData.users.plan, 
      userApiKey
    );

    sendSSEMessage(res, 'status', { message: 'AI processing completed. Parsing response...' });

    const parsedResponse = parseAIResponse(aiResponse);

    // Ensure files array exists
    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      parsedResponse.files = [];
    }

    sendSSEMessage(res, 'final', {
      success: true,
      data: {
        ...parsedResponse,
        generationMode: 'custom',
        usage: {
          count: countResult.count,
          limit: countResult.limit,
          remaining: countResult.remaining,
          plan: apiKeyData.users.plan
        }
      },
      metadata: {
        originalProjectType: projectType,
        projectLanguage: projectLanguage,
        userPrompt: userPrompt,
        processingTime: new Date().toISOString(),
        generationMode: 'custom',
        apiKeyUser: apiKeyData.name,
        selectedModel: selectedModel
      }
    });

    sendSSEMessage(res, 'complete', { message: 'Custom generation completed successfully' });
    endSSE(res);

  } catch (error) {
    console.error('Error in custom file generation:', error);
    sendSSEMessage(res, 'error', {
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    endSSE(res);
  }
});

// UPDATED /api/optimize-files route
app.post('/api/optimize-files', async (req, res) => {
  try {
    const { projectType, files, projectLanguage } = req.body;
    
    const validationResult = await validateAndProcessRequest(req, res, [
      'projectType', 'projectLanguage', 'files'
    ]);
    
    if (!validationResult) return;
    
    const { apiKeyData, countResult, selectedModel, userApiKey } = validationResult;

    // Validation for files
    if (!files || !Array.isArray(files) || files.length === 0) {
      sendSSEMessage(res, 'error', { error: 'Files array is required and cannot be empty' });
      endSSE(res);
      return;
    }

    sendSSEMessage(res, 'status', { message: 'Creating optimization analysis...' });
    
    const prompt = createOptimizationPrompt(projectType, projectLanguage, files);

    sendSSEMessage(res, 'status', { message: 'Starting AI optimization analysis with streaming...' });
    
    // UPDATED: Pass user plan and API key to callAIModel
    const aiResponse = await callAIModel(
      prompt, 
      selectedModel, 
      res, 
      apiKeyData.users.plan, 
      userApiKey
    );

    sendSSEMessage(res, 'status', { message: 'AI optimization completed. Parsing response...' });

    const parsedResponse = parseAIResponse(aiResponse);

    // Ensure files array exists
    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      parsedResponse.files = [];
    }

    sendSSEMessage(res, 'final', {
      success: true,
      data: {
        ...parsedResponse,
        optimizationMode: true,
        originalFilesCount: files.length,
        usage: {
          count: countResult.count,
          limit: countResult.limit,
          remaining: countResult.remaining,
          plan: apiKeyData.users.plan
        }
      },
      metadata: {
        originalProjectType: projectType,
        projectLanguage: projectLanguage,
        originalFilesProcessed: files.length,
        processingTime: new Date().toISOString(),
        optimizationMode: true,
        apiKeyUser: apiKeyData.name,
        selectedModel: selectedModel
      }
    });

    sendSSEMessage(res, 'complete', { message: 'File optimization completed successfully' });
    endSSE(res);

  } catch (error) {
    console.error('Error in file optimization:', error);
    sendSSEMessage(res, 'error', {
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    endSSE(res);
  }
});

app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const { userName } = req.body;
    
    console.log('=== CANCEL SUBSCRIPTION REQUEST ===');
    console.log('Request body:', req.body);
    console.log('UserName:', userName);

    if (!userName) {
      console.log('ERROR: Missing userName');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'UserName is required'
      });
    }

    // Check if user exists and get their subscription details
    console.log('Checking if user exists with name:', userName);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('name, subscription_id, subscription_status, plan')
      .eq('name', userName)
      .single();

    if (userError) {
      console.log('=== USER LOOKUP ERROR ===');
      console.log('Full userError object:', JSON.stringify(userError, null, 2));
      
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: 'User account not found'
      });
    }

    console.log('User found:', user);

    // Check if user has an active subscription
    if (!user.subscription_id) {
      console.log('ERROR: User has no subscription');
      return res.status(400).json({
        success: false,
        error: 'No subscription found',
        message: 'User does not have an active subscription'
      });
    }

    // Check if subscription is already cancelled or scheduled for cancellation
    if (user.subscription_status === 'cancelled') {
      console.log('ERROR: Subscription already cancelled');
      return res.status(400).json({
        success: false,
        error: 'Already cancelled',
        message: 'Subscription is already cancelled'
      });
    }

    if (user.subscription_status === 'cancel_at_period_end') {
      console.log('ERROR: Subscription already scheduled for cancellation');
      return res.status(400).json({
        success: false,
        error: 'Already scheduled for cancellation',
        message: 'Subscription is already scheduled to cancel at the end of the billing period'
      });
    }

    // Check if subscription is past due
    if (user.subscription_status === 'past_due') {
      console.log('ERROR: Subscription is past due');
      return res.status(400).json({
        success: false,
        error: 'Subscription past due',
        message: 'Cannot cancel a past due subscription. Please update your payment method first or contact support.'
      });
    }

    // Cancel subscription in Paddle at the end of billing period
    console.log('Cancelling Paddle subscription at end of billing period:', user.subscription_id);
    try {
      const cancelRequest = {
        effective_from: 'next_billing_period'
      };

      console.log('Sending cancel request to Paddle:', cancelRequest);
      
      const response = await fetch(`https://api.paddle.com/subscriptions/${user.subscription_id}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cancelRequest)
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.log('Paddle API error response:', errorData);
        throw new Error(`Paddle API error: ${response.status} - ${errorData}`);
      }

      const cancelledSubscription = await response.json();
      console.log('Paddle subscription cancellation scheduled successfully:', cancelledSubscription);

      // Check if Paddle returned a scheduled_change for cancellation
      const hasScheduledCancellation = cancelledSubscription.data?.scheduled_change?.action === 'cancel';
      
      if (hasScheduledCancellation) {
        // Update user subscription status to indicate cancellation is scheduled
        console.log('Updating user subscription status to cancel_at_period_end...');
        const { error: updateError } = await supabase
          .from('users')
          .update({ 
            subscription_status: 'cancel_at_period_end'
          })
          .eq('name', user.name);

        if (updateError) {
          console.log('=== USER UPDATE ERROR ===');
          console.log('Full updateError object:', JSON.stringify(updateError, null, 2));
          
          return res.status(500).json({
            success: false,
            error: 'Database update failed',
            message: 'Subscription was cancelled in Paddle but failed to update local status'
          });
        }

        console.log('User subscription status updated successfully to cancel_at_period_end');
        
        res.json({
          success: true,
          message: 'Subscription cancelled successfully',
          details: 'Your subscription will remain active until the end of your current billing period. You will continue to have Pro access until then.',
          status: 'cancel_at_period_end',
          effective_at: cancelledSubscription.data?.scheduled_change?.effective_at
        });
      } else {
        // Immediate cancellation (though we requested next_billing_period)
        console.log('Subscription was cancelled immediately');
        const { error: updateError } = await supabase
          .from('users')
          .update({ 
            subscription_status: 'cancelled',
            plan: 'free'
          })
          .eq('name', user.name);

        if (updateError) {
          console.log('=== USER UPDATE ERROR ===');
          console.log('Full updateError object:', JSON.stringify(updateError, null, 2));
        }

        res.json({
          success: true,
          message: 'Subscription cancelled immediately',
          details: 'Your subscription has been cancelled and you have been downgraded to the free plan.',
          status: 'cancelled'
        });
      }

    } catch (paddleError) {
      console.log('=== PADDLE CANCELLATION ERROR ===');
      console.log('Full paddleError object:', JSON.stringify(paddleError, null, 2));
      console.log('Error message:', paddleError.message);
      
      return res.status(500).json({
        success: false,
        error: 'Paddle cancellation failed',
        message: 'Failed to cancel subscription with payment provider',
        details: paddleError.message
      });
    }

  } catch (error) {
    console.log('=== MAIN CATCH BLOCK ERROR ===');
    console.log('Full error object:', JSON.stringify(error, null, 2));
    console.log('Error name:', error.name);
    console.log('Error message:', error.message);
    console.log('Error stack:', error.stack);
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to cancel subscription',
      details: error.message
    });
  }
});

// Create subscription endpoint (unchanged)
app.post('/api/payment/create-subscription', async (req, res) => {
  try {
    const { userName, plan } = req.body;
    
    console.log('=== CREATE SUBSCRIPTION REQUEST ===');
    console.log('Request body:', req.body);
    console.log('UserName:', userName);
    console.log('Plan:', plan);

    if (!userName || !plan) {
      console.log('ERROR: Missing required fields');
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'UserName and plan are required'
      });
    }

    // Check if user exists
    console.log('Checking if user exists with name:', userName);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('name')
      .eq('name', userName)
      .single();

    if (userError) {
      console.log('=== USER LOOKUP ERROR ===');
      console.log('Full userError object:', JSON.stringify(userError, null, 2));
      console.log('Error message:', userError.message);
      console.log('Error details:', userError.details);
      console.log('Error hint:', userError.hint);
      console.log('Error code:', userError.code);
      
      return res.status(404).json({
        error: 'User not found',
        message: 'Please create an account first'
      });
    }

    console.log('User found:', user);

    // Return price ID for Paddle checkout
    const priceId = process.env.PADDLE_PRICE_ID || 'pri_01k4ek5kezcsa14ezw9whm5yjs';

    console.log('Returning price ID for Paddle checkout:', priceId);

    // Update user with pending subscription status
    console.log('Updating user with pending subscription status...');
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        subscription_status: 'pending'
      })
      .eq('name', user.name);

    if (updateError) {
      console.log('=== USER UPDATE ERROR ===');
      console.log('Full updateError object:', JSON.stringify(updateError, null, 2));
      console.log('Warning: Failed to update user with pending status, but continuing');
    } else {
      console.log('User updated with pending subscription status successfully');
    }

    console.log('=== SUBSCRIPTION CREATION SUCCESSFUL ===');
    res.json({
      success: true,
      priceId: priceId
    });

  } catch (error) {
    console.log('=== MAIN CATCH BLOCK ERROR ===');
    console.log('Full error object:', JSON.stringify(error, null, 2));
    console.log('Error name:', error.name);
    console.log('Error message:', error.message);
    console.log('Error stack:', error.stack);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create subscription',
      details: error.message,
      errorName: error.name
    });
  }
});




app.post('/api/generate-api-key', async (req, res) => {
  try {
    const { name, api_key: userProvidedApiKey } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Name is required and must be a valid string'
      });
    }

    const userName = name.trim();

    // Check if user exists, if not create them with free plan
    const { data: existingUser, error: userCheckError } = await supabase
      .from('users')
      .select('name, plan')
      .eq('name', userName)
      .single();

    if (userCheckError && userCheckError.code !== 'PGRST116') {
      throw userCheckError;
    }

    // Create user if doesn't exist
    if (!existingUser) {
      const { error: userCreateError } = await supabase
        .from('users')
        .insert([{
          name: userName,
          plan: 'free'
        }]);

      if (userCreateError) {
        throw userCreateError;
      }
    }

    const userPlan = existingUser?.plan || 'free';

    // Check if API key already exists for this user
    const { data: existingApiKey, error: apiKeyCheckError } = await supabase
      .from('api_keys')
      .select('name, api_key, count, last_reset_date')
      .eq('name', userName)
      .single();

    if (apiKeyCheckError && apiKeyCheckError.code !== 'PGRST116') {
      throw apiKeyCheckError;
    }

    // If API key already exists and is not null, return error
    if (existingApiKey && existingApiKey.api_key) {
      return res.status(409).json({
        success: false,
        error: 'API key already exists for this user. Delete existing key first.'
      });
    }

    let newApiKey;
    let hashedApiKey;

    // Handle based on user plan
    if (userPlan === 'free') {
      // FREE USERS: Must provide their own API key
      if (!userProvidedApiKey || typeof userProvidedApiKey !== 'string' || userProvidedApiKey.trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'Free users must provide their own API key'
        });
      }

      // Validate API key format (optional - you can add more specific validation)
      const trimmedApiKey = userProvidedApiKey.trim();
      if (trimmedApiKey.length < 10) { // Basic length check
        return res.status(400).json({
          success: false,
          error: 'Invalid API key format'
        });
      }

      newApiKey = trimmedApiKey;
      hashedApiKey = await hashApiKey(newApiKey);
    } else if (userPlan === 'pro') {
      // PRO USERS: Generate API key automatically
      newApiKey = 'sk-' + crypto.randomBytes(32).toString('hex');
      hashedApiKey = await hashApiKey(newApiKey);
    } else {
      return res.status(403).json({
        success: false,
        error: 'Invalid user plan. Only free and paid users are supported.'
      });
    }

    // Preserve count and reset date logic
    let preservedCount = 0;
    let preservedResetDate = new Date().toISOString().split('T')[0];
    
    if (existingApiKey) {
      // BOTH FREE AND PRO USERS: Daily reset logic
      const today = new Date().toISOString().split('T')[0];
      
      if (existingApiKey.last_reset_date === today) {
        // Same day - preserve the count to maintain daily limit
        preservedCount = existingApiKey.count;
        preservedResetDate = existingApiKey.last_reset_date;
      } else {
        // Different day - reset count to 0 (normal daily reset)
        preservedCount = 0;
        preservedResetDate = today;
      }
    }

    // Insert or update API key record with preserved count
    if (existingApiKey) {
      // Update existing record
      const { error: updateError } = await supabase
        .from('api_keys')
        .update({
          api_key: hashedApiKey,
          count: preservedCount,
          last_reset_date: preservedResetDate
        })
        .eq('name', userName);

      if (updateError) {
        throw updateError;
      }
    } else {
      // Insert new record with count 0 (new user)
      const { error: insertError } = await supabase
        .from('api_keys')
        .insert([{
          name: userName,
          api_key: hashedApiKey,
          count: 0,
          last_reset_date: new Date().toISOString().split('T')[0]
        }]);

      if (insertError) {
        throw insertError;
      }
    }

    // Different response messages based on plan
    const responseMessage = userPlan === 'free' 
      ? 'API key stored successfully' 
      : 'API key generated successfully';

    const responseData = {
      name: userName,
      plan: userPlan,
      count: preservedCount,
      preserved_usage: preservedCount > 0
    };

    // Only return the plain API key to pro users (since they generated it)
    // Free users already have their key, so we don't need to return it
    if (userPlan === 'pro') {
      responseData.api_key = newApiKey;
    }

    res.json({
      success: true,
      message: responseMessage,
      data: responseData
    });

  } catch (error) {
    console.error('❌ Error processing API key:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});
// Route 2: Delete API Key
app.post('/api/delete-api-key', async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Name is required and must be a valid string'
      });
    }

    const userName = name.trim();

    // Check if API key exists for this user
    const { data: existingApiKey, error: checkError } = await supabase
      .from('api_keys')
      .select('name, api_key')
      .eq('name', userName)
      .single();

    if (checkError) {
      if (checkError.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'No API key record found for this user'
        });
      }
      throw checkError;
    }

    // Check if API key is already null
    if (!existingApiKey.api_key) {
      return res.status(404).json({
        success: false,
        error: 'No active API key found for this user'
      });
    }

    // Set API key to null
    const { error: updateError } = await supabase
      .from('api_keys')
      .update({
        api_key: null
      })
      .eq('name', userName);

    if (updateError) {
      throw updateError;
    }

    // console.log(`✅ Deleted API key for user: ${userName}`);

    res.json({
      success: true,
      message: 'API key deleted successfully',
      data: {
        name: userName,
        deleted_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error deleting API key:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Route 3: Update Count (Increment by 1)
app.post('/api/update-count', async (req, res) => {
  try {
    const { api_key } = req.body;

    // Validation
    if (!api_key || typeof api_key !== 'string' || api_key.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'API key is required and must be a valid string'
      });
    }

    const apiKey = api_key.trim();

    // Find the API key and associated user (using hash comparison)
    const apiKeyData = await findApiKeyRecord(apiKey);
    
    if (!apiKeyData) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    // FOR FREE USERS: Check if they've reached lifetime limit
    if (apiKeyData.users.plan === 'free' && apiKeyData.count >= 3) {
      return res.status(429).json({
        success: false,
        error: 'Free plan limit reached. You have used all 3 lifetime requests. Please upgrade to Pro plan.',
        data: {
          count: apiKeyData.count,
          limit: 3,
          remaining: 0,
          plan: 'free',
          isLifetimeLimit: true
        }
      });
    }

    // USE THE POSTGRESQL FUNCTION
    const { data: countResult, error: countError } = await supabase
      .rpc('increment_api_count', {
        api_name: apiKeyData.name
      });

    if (countError) {
      throw countError;
    }

    if (!countResult.success) {
      return res.status(429).json({
        success: false,
        error: countResult.error,
        data: {
          count: countResult.count,
          limit: countResult.limit,
          remaining: countResult.remaining,
          plan: apiKeyData.users.plan
        }
      });
    }

    // console.log(`Incremented count for user: ${apiKeyData.name} (${countResult.count}/${countResult.limit})`);

    res.json({
      success: true,
      message: 'Count updated successfully',
      data: {
        count: countResult.count,
        limit: countResult.limit,
        remaining: countResult.remaining,
        plan: apiKeyData.users.plan,
        reset_date: new Date().toISOString().split('T')[0]
      }
    });

  } catch (error) {
    console.error('Error updating count:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Route 4: Get User API Key Info by Name
app.post('/api/get-user-api-info', async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Name is required and must be a valid string'
      });
    }

    const userName = name.trim();

    // Get user's API key info with plan details AND subscription info
    const { data: apiKeyData, error: findError } = await supabase
      .from('api_keys')
      .select(`
        name,
        api_key,
        count,
        last_reset_date,
        created_at,
        users!inner(
          plan,
          subscription_status,
          subscription_id
        )
      `)
      .eq('name', userName)
      .single();

    if (findError) {
      if (findError.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'No API key found for this user'
        });
      }
      throw findError;
    }

    // Check if API key is null (deleted)
    if (!apiKeyData.api_key) {
      return res.status(404).json({
        success: false,
        error: 'User exists but has no active API key'
      });
    }

    // Get plan limit
    const { data: planLimit, error: limitError } = await supabase
      .from('plan_limits')
      .select('limit_value')
      .eq('plan', apiKeyData.users.plan)
      .single();

    if (limitError) {
      throw limitError;
    }

    const limit = planLimit.limit_value;
    let currentCount = apiKeyData.count;

    // ✅ MODIFIED LOGIC: For free users, no daily reset
    if (apiKeyData.users.plan === 'free') {
      // Free users: count never resets, use lifetime count
      currentCount = apiKeyData.count;
    } else {
      // Pro users: check if count needs to be reset for today
      const today = new Date().toISOString().split('T')[0];
      if (apiKeyData.last_reset_date !== today) {
        currentCount = 0;
      }
    }

    // console.log(`📊 Retrieved API info for user: ${userName}`);

    // Show a generic masked API key format to indicate one exists
    const maskedApiKey = "sk-abc123************************def456";

    res.json({
      success: true,
      data: {
        name: userName,
        api_key: maskedApiKey, // Generic masked format
        limit: limit,
        count: currentCount,
        remaining: limit - currentCount,
        plan: apiKeyData.users.plan,
        subscription_status: apiKeyData.users.subscription_status,
        subscription_id: apiKeyData.users.subscription_id,
        last_reset_date: apiKeyData.last_reset_date,
        created_at: apiKeyData.created_at,
        is_limit_reached: currentCount >= limit,
        isLifetimeLimit: apiKeyData.users.plan === 'free' // Add this flag for frontend
      }
    });

  } catch (error) {
    console.error('❌ Error getting user API info:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});


// Route to handle user authentication and database operations
app.post('/api/handle-user-auth', async (req, res) => {
  try {
    const { email } = req.body;

    // Validation
    if (!email || typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Email is required and must be a valid string'
      });
    }

    const userEmail = email.trim();

    // console.log(`🔐 Processing user auth for: ${userEmail}`);

    // Store user in database (same logic as original frontend code)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .upsert(
        { 
          name: userEmail,
          plan: 'free'
        },
        { 
          onConflict: 'name',
          ignoreDuplicates: false 
        }
      )
      .select();

    if (userError) {
      console.error('Detailed user error:', userError);
      console.error('Error code:', userError.code);
      console.error('Error message:', userError.message);
      console.error('Error details:', userError.details);
      throw new Error(`Failed to create/update user: ${userError.message}`);
    } else {
      // console.log('User created/updated successfully:', userData);
    }

    // Create/update API key entry (same logic as original frontend code)
    const { data: apiData, error: apiKeyError } = await supabase
      .from('api_keys')
      .upsert(
        { 
          name: userEmail,
          count: 0,
          last_reset_date: new Date().toISOString().split('T')[0]
        },
        { 
          onConflict: 'name',
          ignoreDuplicates: false 
        }
      )
      .select();

    if (apiKeyError) {
      console.error('Detailed API key error:', apiKeyError);
      console.error('Error code:', apiKeyError.code);
      console.error('Error message:', apiKeyError.message);
      console.error('Error details:', apiKeyError.details);
      throw new Error(`Failed to create/update API key record: ${apiKeyError.message}`);
    } else {
      // console.log('API key created/updated successfully:', apiData);
    }

    // Success response
    res.json({
      success: true,
      message: 'User successfully processed and stored in database'
    });

  } catch (error) {
    console.error('❌ Error in handle-user-auth:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process user authentication'
    });
  }
});

// Route to submit feedback
app.post('/api/submit-feedback', async (req, res) => {
  try {
    const { title, description } = req.body;

    // Validation
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Title is required and must be a valid string'
      });
    }

    if (!description || typeof description !== 'string' || description.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Description is required and must be a valid string'
      });
    }

    const feedbackData = {
      title: title.trim(),
      description: description.trim()
    };

    // console.log('📝 Submitting feedback:', feedbackData.title);

    // Insert feedback into database (same logic as original frontend code)
    const { data, error: supabaseError } = await supabase
      .from('feedback')
      .insert([feedbackData])
      .select();

    if (supabaseError) {
      console.error('Supabase error:', supabaseError);
      throw new Error(`Failed to submit feedback: ${supabaseError.message}`);
    }

    // console.log('Feedback submitted successfully:', data);

    // Success response
    res.json({
      success: true,
      message: 'Feedback submitted successfully',
      data: data
    });

  } catch (error) {
    console.error('❌ Error in submit-feedback:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to submit feedback'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
  });
});





// Start server
app.listen(port, () => {
  console.log(`\n🚀 Deepseek Code Processor Server running on port ${port}`);
  console.log(`📋 Health check: http://localhost:${port}/api/health`);
  console.log(`🤖 Process endpoint: http://localhost:${port}/api/process-code`);
});
