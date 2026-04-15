const https = require('https');

const GRAPH_API_VERSION = 'v25.0';

function httpRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {}
    };

    let bodyStr = '';
    if (body) {
      if (method === 'POST') {
        bodyStr = new URLSearchParams(body).toString();
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getPageToken(systemUserToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts?access_token=${encodeURIComponent(systemUserToken)}`;
  const result = await httpRequest(url, 'GET');
  if (result.error) throw new Error(result.error.message);
  if (!result.data || !result.data.length) throw new Error('No pages found for this token');
  return result.data[0].access_token;
}

async function publishToFacebook(pageId, pageToken, imageUrl, caption) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/photos`;
  const result = await httpRequest(url, 'POST', {
    message: caption,
    url: imageUrl,
    access_token: pageToken
  });
  if (result.error) throw new Error(`FB publish failed: ${result.error.message}`);
  return result.post_id || result.id;
}

async function publishToInstagram(igUserId, igAccessToken, imageUrl, caption) {
  // Step 1: Create media container
  const containerUrl = `https://graph.instagram.com/${GRAPH_API_VERSION}/${igUserId}/media`;
  const container = await httpRequest(containerUrl, 'POST', {
    image_url: imageUrl,
    caption: caption,
    access_token: igAccessToken
  });
  if (container.error) throw new Error(`IG container failed: ${container.error.message}`);
  const creationId = container.id;

  // Step 2: Wait for processing
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Publish
  const publishUrl = `https://graph.instagram.com/${GRAPH_API_VERSION}/${igUserId}/media_publish`;
  const result = await httpRequest(publishUrl, 'POST', {
    creation_id: creationId,
    access_token: igAccessToken
  });
  if (result.error) throw new Error(`IG publish failed: ${result.error.message}`);
  return result.id;
}

async function publishPost(client, imageUrl, caption) {
  const results = { fb_post_id: null, ig_media_id: null, errors: [] };

  // Get page token from system user token
  let pageToken = null;
  if (client.fb_system_user_token && client.fb_page_id) {
    try {
      pageToken = await getPageToken(client.fb_system_user_token);
    } catch (err) {
      results.errors.push(`FB token exchange: ${err.message}`);
    }
  }

  // Publish to Facebook
  if (pageToken && client.fb_page_id) {
    try {
      results.fb_post_id = await publishToFacebook(client.fb_page_id, pageToken, imageUrl, caption);
    } catch (err) {
      results.errors.push(`FB: ${err.message}`);
    }
  }

  // Publish to Instagram
  if (client.ig_user_id && client.ig_access_token) {
    try {
      results.ig_media_id = await publishToInstagram(client.ig_user_id, client.ig_access_token, imageUrl, caption);
    } catch (err) {
      results.errors.push(`IG: ${err.message}`);
    }
  }

  return results;
}

module.exports = { publishPost, publishToFacebook, publishToInstagram, getPageToken };
