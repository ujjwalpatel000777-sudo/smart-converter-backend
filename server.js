const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { Paddle } = require('@paddle/paddle-node-sdk');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

const paddle = new Paddle(process.env.PADDLE_API_KEY);


// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
// const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE
const supabase = createClient(supabaseUrl, supabaseServiceRole);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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



// Helper function to hash API key
async function hashApiKey(apiKey) {
  const saltRounds = 12;
  return await bcrypt.hash(apiKey, saltRounds);
}

// Helper function to verify API key
async function verifyApiKey(plainApiKey, hashedApiKey) {
  return await bcrypt.compare(plainApiKey, hashedApiKey);
}

// Helper function to find API key by comparing with all hashed keys
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

// Enhanced Paddle webhook handlers
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

  const { error } = await supabase
    .from('users')
    .update({ 
      plan: 'pro',
      subscription_status: 'active',
      subscription_id: subscription.id
    })
    .eq('name', user.name);

  if (error) {
    console.log('ERROR: Failed to activate subscription in database');
    console.log('Database error:', JSON.stringify(error, null, 2));
  } else {
    console.log('SUCCESS: Subscription activated for user:', user.name);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('=== HANDLING SUBSCRIPTION UPDATED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  // Check if subscription has a scheduled change to cancel
  if (subscription.scheduled_change && subscription.scheduled_change.action === 'cancel') {
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
  } else if (subscription.status === 'active' && !subscription.scheduled_change) {
    // Subscription is active with no scheduled changes (cancellation was removed)
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
  }
}

async function handleSubscriptionCancelled(subscription) {
  console.log('=== HANDLING SUBSCRIPTION CANCELLED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  const { error } = await supabase
    .from('users')
    .update({ 
      plan: 'free',
      subscription_status: 'cancelled'
    })
    .eq('subscription_id', subscription.id);
   
  if (error) {
    console.log('ERROR: Failed to cancel subscription in database');
    console.log('Database error:', JSON.stringify(error, null, 2));
  } else {
    console.log('SUCCESS: Subscription cancelled and downgraded to free for subscription:', subscription.id);
  }
}

async function handleSubscriptionPaused(subscription) {
  console.log('=== HANDLING SUBSCRIPTION PAUSED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  const { error } = await supabase
    .from('users')
    .update({ 
      plan: 'free',
      subscription_status: 'paused'
    })
    .eq('subscription_id', subscription.id);
   
  if (error) {
    console.log('ERROR: Failed to pause subscription in database');
    console.log('Database error:', JSON.stringify(error, null, 2));
  } else {
    console.log('SUCCESS: Subscription paused for subscription:', subscription.id);
  }
}

async function handleSubscriptionResumed(subscription) {
  console.log('=== HANDLING SUBSCRIPTION RESUMED ===');
  console.log('Subscription object:', JSON.stringify(subscription, null, 2));

  const { error } = await supabase
    .from('users')
    .update({ 
      plan: 'pro',
      subscription_status: 'active'
    })
    .eq('subscription_id', subscription.id);
   
  if (error) {
    console.log('ERROR: Failed to resume subscription in database');
    console.log('Database error:', JSON.stringify(error, null, 2));
  } else {
    console.log('SUCCESS: Subscription resumed for subscription:', subscription.id);
  }
}

// Enhanced cancel subscription endpoint
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

    // Cancel subscription in Paddle at the end of billing period
    console.log('Cancelling Paddle subscription at end of billing period:', user.subscription_id);
    try {
      const cancelRequest = {
        effective_from: 'next_billing_period'
      };

      console.log('Sending cancel request to Paddle:', cancelRequest);
      
      const response = await fetch(`https://sandbox-api.paddle.com/subscriptions/${user.subscription_id}/cancel`, {
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

    console.log('=== SUBSCRIPTION CANCELLATION SUCCESSFUL ===');
    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
      details: 'Your subscription will remain active until the end of your current billing period. You will continue to have Pro access until then.',
      status: 'cancel_at_period_end'
    });

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


// Endpoint to process code with Gemini
app.post('/api/process-code', async (req, res) => {
  try {
    const { api_key, projectType, files, totalFiles, totalWords, workspacePath, dependencies, projectLanguage, packageJson } = req.body;
    
    // API key validation
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

    // USE THE POSTGRESQL FUNCTION FOR COUNT MANAGEMENT
    const { data: countResult, error: countError } = await supabase
      .rpc('increment_api_count', {
        api_name: apiKeyData.name
      });

    if (countError) {
      throw countError;
    }

    // Check if the function indicates limit reached or other error
    if (!countResult.success) {
      return res.status(429).json({
        success: false,
        error: countResult.error,
        data: {
          count: countResult.count,
          limit: countResult.limit,
          remaining: countResult.limit - countResult.count,
          plan: apiKeyData.users.plan
        }
      });
    }

    // console.log(`API usage: ${apiKeyData.name} (${countResult.count}/${countResult.limit}) - Processing ${projectType} project`);

    // Validation for files...
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input: files array is required and cannot be empty'
      });
    }

    // Validation for packageJson
    if (!packageJson || typeof packageJson !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid input: packageJson is required and must be an object'
      });
    }

    // console.log(`\nCOMPLETE REWRITE MODE: Processing ${projectType} project`);
    // console.log(`Files to COMPLETELY REPLACE: ${files.length}`);
    // console.log(`Total words: ${totalWords}`);
    
    // Create prompt for complete rewrite
    const prompt = createGeminiPrompt(projectType, files, projectLanguage, packageJson);
    
    // Get Gemini response
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const generatedText = response.text();

    // console.log('Received Gemini response for complete rewrite');

    // IMPROVED JSON PARSING WITH BETTER ERROR HANDLING
    let parsedResponse;
    try {
      // Log the raw response for debugging (truncated)
      // console.log('Raw Gemini response (first 500 chars):', generatedText.substring(0, 500));
      
      // Try multiple parsing strategies
      let jsonContent = '';
      
      // Strategy 1: Look for JSON block between ```json and ```
      const codeBlockMatch = generatedText.match(/```json\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonContent = codeBlockMatch[1].trim();
        // console.log('Found JSON in code block');
      }
      
      // Strategy 2: Look for JSON object starting with { and ending with }
      if (!jsonContent) {
        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonContent = jsonMatch[0];
          // console.log('Found JSON object in response');
        }
      }
      
      // Strategy 3: Try to clean the response and extract JSON
      if (!jsonContent) {
        // Remove common prefixes/suffixes that Gemini might add
        let cleaned = generatedText
          .replace(/^[\s\S]*?(?=\{)/, '') // Remove everything before first {
          .replace(/\}[\s\S]*$/, '}') // Remove everything after last }
          .trim();
        
        if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
          jsonContent = cleaned;
          // console.log('Extracted JSON from cleaned response');
        }
      }
      
      // If we found JSON content, try to parse it
      if (jsonContent) {
        parsedResponse = JSON.parse(jsonContent);
        // console.log('Successfully parsed JSON response');
      } else {
        // If no JSON found, log the full response for debugging
        console.error('No JSON content found in Gemini response');
        console.error('Full response:', generatedText);
        throw new Error('No valid JSON found in Gemini response');
      }
      
    } catch (parseError) {
      console.error('JSON parsing failed:', parseError.message);
      console.error('Raw response:', generatedText);
      
      // Try one more fallback - attempt to fix common JSON issues
      try {
        let fixedJson = generatedText
          .replace(/^[\s\S]*?(\{)/, '$1') // Remove everything before first {
          .replace(/(\})[\s\S]*$/, '$1') // Remove everything after last }
          .replace(/,\s*}/g, '}') // Remove trailing commas
          .replace(/,\s*]/g, ']') // Remove trailing commas in arrays
          .trim();
        
        parsedResponse = JSON.parse(fixedJson);
        // console.log('Successfully parsed JSON after cleanup');
      } catch (fallbackError) {
        console.error('Fallback parsing also failed:', fallbackError.message);
        
        // Return a structured error response instead of throwing
        return res.status(500).json({
          success: false,
          error: 'Failed to parse Gemini AI response as JSON',
          details: {
            originalError: parseError.message,
            fallbackError: fallbackError.message,
            responsePreview: generatedText.substring(0, 200) + '...',
            suggestion: 'The AI response format was unexpected. This might be a temporary issue. Please try again.'
          }
        });
      }
    }

    // Validate that we have the expected structure
    if (!parsedResponse || typeof parsedResponse !== 'object') {
      console.error('Parsed response is not an object:', parsedResponse);
      return res.status(500).json({
        success: false,
        error: 'Invalid response structure from Gemini AI',
        details: 'Expected JSON object but got: ' + typeof parsedResponse
      });
    }

    // Validate required fields
    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      console.warn('Response missing files array, creating empty array');
      parsedResponse.files = [];
    }

    // console.log(`Parsed response contains ${parsedResponse.files.length} files`);

    // Send response back to extension (NO FILE OPERATIONS)
    res.json({
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
        originalTotalFiles: totalFiles,
        originalTotalWords: totalWords,
        projectLanguage: projectLanguage,
        processingTime: new Date().toISOString(),
        replacementMode: true,
        apiKeyUser: apiKeyData.name
      }
    });

  } catch (error) {
    console.error('Error in complete replacement mode:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});


app.post('/api/generate-api-key', async (req, res) => {
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

    // Check if API key already exists for this user
    const { data: existingApiKey, error: apiKeyCheckError } = await supabase
      .from('api_keys')
      .select('name, api_key, count, last_reset_date') // ✅ GET EXISTING COUNT AND RESET DATE
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

    // Generate new API key
    const newApiKey = 'sk-' + crypto.randomBytes(32).toString('hex');

    // Hash the API key before storing
    const hashedApiKey = await hashApiKey(newApiKey);

    // ✅ PRESERVE COUNT AND RESET DATE LOGIC
    let preservedCount = 0;
    let preservedResetDate = new Date().toISOString().split('T')[0];
    
    if (existingApiKey) {
      // If user had a deleted key, preserve their usage for today
      const today = new Date().toISOString().split('T')[0];
      
      if (existingApiKey.last_reset_date === today) {
        // Same day - preserve the count to maintain daily limit
        preservedCount = existingApiKey.count;
        preservedResetDate = existingApiKey.last_reset_date;
        // console.log(`✅ Preserving count ${preservedCount} for user ${userName} (same day)`);
      } else {
        // Different day - reset count to 0 (normal daily reset)
        preservedCount = 0;
        preservedResetDate = today;
        // console.log(`✅ Resetting count for user ${userName} (new day)`);
      }
    }

    // Insert or update API key record with preserved count
    if (existingApiKey) {
      // Update existing record - PRESERVE COUNT
      const { error: updateError } = await supabase
        .from('api_keys')
        .update({
          api_key: hashedApiKey,
          count: preservedCount,          // ✅ PRESERVE EXISTING COUNT
          last_reset_date: preservedResetDate  // ✅ PRESERVE RESET DATE
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

    // console.log(`✅ Generated API key for user: ${userName} (count preserved: ${preservedCount})`);

    res.json({
      success: true,
      message: 'API key generated successfully',
      data: {
        name: userName,
        api_key: newApiKey, // Return the plain API key to user
        plan: existingUser?.plan || 'free',
        count: preservedCount,  // ✅ SHOW PRESERVED COUNT
        preserved_usage: preservedCount > 0 // ✅ INDICATE IF USAGE WAS PRESERVED
      }
    });

  } catch (error) {
    console.error('❌ Error generating API key:', error);
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
    const today = new Date().toISOString().split('T')[0];
    let currentCount = apiKeyData.count;

    // Check if count needs to be reset for today
    if (apiKeyData.last_reset_date !== today) {
      currentCount = 0;
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
        subscription_status: apiKeyData.users.subscription_status, // ADD THIS
        subscription_id: apiKeyData.users.subscription_id, // ADD THIS
        last_reset_date: apiKeyData.last_reset_date,
        created_at: apiKeyData.created_at,
        is_limit_reached: currentCount >= limit
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

// Route to check user limit for login
app.get('/api/check-user-limit', async (req, res) => {
  try {
    // ===================================================
    // CONFIGURABLE USER LIMIT - Change this value as needed
    // ===================================================
    const MAX_USERS = 10;

    // Get current user count from database
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('Error checking user count:', error);
      // Return success if check fails to avoid blocking legitimate users
      return res.json({
        success: true,
        canLogin: true,
        message: 'User limit check temporarily unavailable'
      });
    }

    const currentUserCount = count || 0;
    const limitReached = currentUserCount >= MAX_USERS;
    
    // console.log(`📊 User limit check: ${currentUserCount}/${MAX_USERS} users`);
    
    if (limitReached) {
      return res.json({
        success: true,
        canLogin: false,
        message: `Currently ${MAX_USERS} users only allowed. Try again later.`,
        data: {
          currentUsers: currentUserCount,
          maxUsers: MAX_USERS,
          limitReached: true
        }
      });
    }
    
    // Allow login
    res.json({
      success: true,
      canLogin: true,
      message: 'Login allowed',
      data: {
        currentUsers: currentUserCount,
        maxUsers: MAX_USERS,
        remainingSlots: MAX_USERS - currentUserCount,
        limitReached: false
      }
    });

  } catch (error) {
    console.error('❌ Error in user limit check:', error);
    
    // Return success if error occurs to avoid blocking users
    res.json({
      success: true,
      canLogin: true,
      message: 'User limit check failed, allowing login',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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



function createGeminiPrompt(projectType, files, projectLanguage, packageJson) {
  const fileExtension = projectLanguage === 'TypeScript' ? '.ts/.tsx' : '.js/.jsx';
  
  const refactoringPrompt = `You are an expert software refactoring assistant. You will COMPLETELY REWRITE all provided files with improved code.

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
  
  **PACKAGE USAGE DETECTION:**
  Look for packages being used in:
  1. Direct imports: import x from 'package-name'
  2. Require statements: require('package-name')
  3. Dynamic imports: import('package-name')
  4. Configuration files that reference packages
  5. Package.json scripts that use packages
  6. Indirect dependencies (packages used by other packages)
  7. Development tools used in build process
  
  **CONSERVATIVE APPROACH:**
  - Only suggest removing packages that are clearly unused
  - When in doubt, keep the package
  - Group related packages together in uninstall commands
  - Provide clear reasoning for why each package can be removed
  
  **SECURITY ANALYSIS - EXTRACT HARDCODED SECRETS:**
  Analyze all code files and identify any hardcoded secrets, API keys, tokens, or sensitive data.
  Look for patterns like:
  - API keys (starting with sk-, pk-, etc.)
  - Database URLs with credentials
  - JWT tokens
  - OAuth secrets
  - Third-party service tokens
  - Email/SMTP credentials
  - Any hardcoded passwords or secrets
  
  **COMPLETE REWRITE INSTRUCTIONS:**
  
  🔄 **TOTAL REPLACEMENT APPROACH:**
  - All provided files will be DELETED and RECREATED from scratch
  - You must provide COMPLETE, WORKING code for every file
  - Maintain ALL existing functionality while improving code quality
  - Create additional utility/helper files as needed
  - Replace ALL hardcoded secrets with process.env variables
  
  **Refactoring Rules to Apply:**
  
  1. **Security First:** 
     - Replace ALL hardcoded secrets with process.env.VARIABLE_NAME
     - Use descriptive environment variable names
  
  2. **Naming Conventions:** 
     - Use camelCase for variables and functions
     - Use PascalCase for classes and components
     - Use UPPER_SNAKE_CASE for constants and env vars
  
  3. **Modularization:** 
     - Break large functions (>50 lines) into smaller functions
     - Extract reusable logic into separate utility files
     - Create shared components for repeated UI patterns
  
  4. **Code Organization:**
     - Create proper file structure (utils/, components/, constants/)
     - Extract constants and configuration into separate files
     - Group related functions into modules

  5. **DEAD CODE AND IMPORT REMOVAL:**
     - **Unused Functions**: Identify and remove functions that are defined but never called
     - **Unused Variables**: Remove variables that are declared but never used
     - **Unused Parameters**: Remove function parameters that aren't used in function body
     - **Unused Imports**: Remove all imports that aren't actually used in the file
     - **Unused Exports**: Remove exports that aren't imported by any other file
     - **Import Consolidation**: Combine multiple imports from same module

  6. **Modern Best Practices:**
     ${projectLanguage === 'TypeScript' ? `
     - Add comprehensive TypeScript types and interfaces
     - Use proper generics and utility types
     - Implement strict null checks
     - Add JSDoc comments for all public APIs
     ` : `
     - Use modern JavaScript features (destructuring, arrow functions)
     - Add comprehensive JSDoc comments
     - Implement proper error handling
     `}
  
  7. **Framework-Specific (${projectType}):**
     - Use modern React hooks instead of class components
     - Implement proper component structure
     - Follow React/Next.js best practices
     - Optimize performance with useMemo, useCallback where needed
  
  8. **Code Documentation:**
     - Add comprehensive JSDoc comments
     - Document all function parameters and return values
     - Add inline comments for complex logic
  
  **FILE STRUCTURE REQUIREMENTS:**
  - Include ALL original files (completely rewritten)
  - Create NEW files for extracted utilities/components
  - Use logical directory structure
  - Update ALL import/export statements to work with new structure
  
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
      "API_KEY": "actual-hardcoded-value-found",
      "DATABASE_URL": "actual-db-url-with-credentials",
      "JWT_SECRET": "actual-jwt-token"
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
      },
      {
        "name": "package-name-2", 
        "type": "devDependency",
        "reason": "Development tool no longer needed after refactoring"
      }
    ],
    "npmUninstallCommands": [
      "npm uninstall package-name-1 package-name-2",
      "npm uninstall --save-dev dev-package-name"
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
  ✅ All import statements must reference correct file paths
  ✅ Code must follow ${projectLanguage} syntax perfectly
  ✅ Response must be valid JSON with exact structure above
  ✅ Extract ALL hardcoded secrets into the "secrets" object
  ✅ Replace hardcoded values with process.env variables in code
  ✅ Provide conservative unused package analysis with clear reasoning
  ✅ Group npm uninstall commands logically for easy execution
  
  **FAILURE CONDITIONS TO AVOID:**
  ❌ No incomplete code or placeholder comments
  ❌ No missing imports or broken references
  ❌ No syntax errors or compilation issues
  ❌ No functionality loss from original code
  ❌ No missed hardcoded secrets
  ❌ No removal of essential packages
  ❌ No unclear reasoning for package removal suggestions`;

  return refactoringPrompt;
}

// Start server
app.listen(port, () => {
  console.log(`\n🚀 Gemini Code Processor Server running on port ${port}`);
  console.log(`📋 Health check: http://localhost:${port}/api/health`);
  console.log(`🤖 Process endpoint: http://localhost:${port}/api/process-code`);
  
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  WARNING: GEMINI_API_KEY not found in environment variables');
  } else {
    console.log('✅ Gemini API key configured');
  }
});


// 5. **DEAD CODE DETECTION & REMOVAL:**
// - **Unused Functions**: Identify and remove functions that are defined but never called
// - **Unused Variables**: Remove variables that are declared but never used
// - **Unused Parameters**: Remove function parameters that aren't used in function body
// - **Unused Imports**: Remove all imports that aren't actually used in the file
// - **Unused Exports**: Remove exports that aren't imported by any other file
// - **Import Consolidation**: Combine multiple imports from same module
