// Standalone test for mbasic.facebook.com message sending
import https from 'https';
import zlib from 'zlib';

const COOKIES = [
  { name: 'datr', value: 'ZbHfaWFLVnCM51DWyxKCsOik' },
  { name: 'fr', value: '0y3efpFjxFcesagLb.AWefdic3bkv4UMtGrJ5_LMtWWVJOr06rIlq0HOWRjix6jajTQP8.BqAkT3..AAA.0.0.BqAkT3.AWcNPTrbhVKXPOhcQnS3ZA-aox0' },
  { name: 'xs', value: '18%3Aa5LNc9JJEBdLcw%3A2%3A1778533624%3A-1%3A-1%3A%3AAcyl5VJmsCW2bcim47uGqBtuj_rnl3Q4iMLq980miA' },
  { name: 'locale', value: 'de_DE' },
  { name: 'c_user', value: '100004490640387' },
  { name: 'sb', value: 'arHfadQYlL4-O3k3w-y2W5rm' },
];

const COOKIE_STRING = COOKIES.map(c => `${c.name}=${c.value}`).join('; ');
const MY_USER_ID = '100004490640387';

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function httpRequest(url, { method = 'GET', body = null, referer = 'https://www.facebook.com/', maxRedirects = 5, mobile = false } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    // Automatically use mobile UA for mbasic.facebook.com
    const isMbasic = urlObj.hostname.includes('mbasic.facebook.com') || mobile;
    const headers = {
      'User-Agent': isMbasic ? UA_MOBILE : UA_DESKTOP,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cookie': COOKIE_STRING,
      'Referer': referer,
      'Connection': 'keep-alive',
    };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let text;
        try {
          const enc = res.headers['content-encoding'];
          if (enc === 'gzip') text = zlib.gunzipSync(raw).toString();
          else if (enc === 'br') text = zlib.brotliDecompressSync(raw).toString();
          else if (enc === 'deflate') text = zlib.inflateSync(raw).toString();
          else text = raw.toString();
        } catch { text = raw.toString(); }

        if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
          console.log(`  ↳ Redirect ${res.statusCode} → ${loc}`);
          resolve(httpRequest(loc, { method: 'GET', referer: url, maxRedirects: maxRedirects - 1 }));
          return;
        }

        resolve({ statusCode: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function resolveUserViaMbasic(query) {
  console.log(`\n=== Resolving user via mbasic: "${query}" ===`);

  // Step 1: Search on mbasic
  console.log('1. Searching on mbasic.facebook.com...');
  const searchUrl = `https://mbasic.facebook.com/search/people/?q=${encodeURIComponent(query)}`;
  const searchResp = await httpRequest(searchUrl, { referer: 'https://mbasic.facebook.com/' });
  console.log(`   Status: ${searchResp.statusCode}, Body length: ${searchResp.body.length}`);

  if (searchResp.body.includes('/login') && searchResp.body.length < 5000) {
    console.log('   ❌ Login page detected on mbasic!');
    console.log('   Body preview:', searchResp.body.substring(0, 500));
    throw new Error('Session expired on mbasic');
  }

  // Look for profile links in mbasic search results
  // mbasic uses simple HTML like <a href="/profile.php?id=123"> or <a href="/username">
  const profileLinks = [];

  // Pattern 1: profile.php?id=123
  const profilePhpPattern = /\/profile\.php\?id=(\d+)/g;
  let m;
  while ((m = profilePhpPattern.exec(searchResp.body)) !== null) {
    if (m[1] !== MY_USER_ID) profileLinks.push(m[1]);
  }

  // Pattern 2: data-gt with profile ID
  const dataGtPattern = /"profile_id"\s*:\s*(\d+)/g;
  while ((m = dataGtPattern.exec(searchResp.body)) !== null) {
    if (m[1] !== MY_USER_ID) profileLinks.push(m[1]);
  }

  // Pattern 3: /messages/thread/USERID
  const threadPattern = /\/messages\/thread\/(\d+)/g;
  while ((m = threadPattern.exec(searchResp.body)) !== null) {
    if (m[1] !== MY_USER_ID) profileLinks.push(m[1]);
  }

  console.log(`   Found ${profileLinks.length} profile IDs: ${[...new Set(profileLinks)].join(', ')}`);

  if (profileLinks.length > 0) {
    return profileLinks[0];
  }

  // Try to find any user-looking links  
  console.log('\n   Looking for user links in body...');
  const allLinks = searchResp.body.match(/href="\/([^?"\/][^"]*?)"/g) || [];
  const userLinks = allLinks.filter(l => !l.includes('/search') && !l.includes('/a/') && !l.includes('/images') && !l.includes('.php') && !l.includes('/help'));
  console.log(`   Potential user links: ${userLinks.slice(0, 10).join(', ')}`);

  // Dump everything after the header/nav to see the search results
  const bodyStart = searchResp.body.indexOf('</nav>');
  if (bodyStart > -1) {
    console.log('\n   Content after nav (search results):');
    console.log(searchResp.body.substring(bodyStart, bodyStart + 5000));
  } else {
    const bodyIdx = searchResp.body.indexOf('<body');
    console.log('\n   Body snippet:', searchResp.body.substring(bodyIdx, bodyIdx + 3000));
  }

  // Also look for any <a> tags that might link to a profile
  const allAnchors = searchResp.body.match(/<a[^>]*href="[^"]*"[^>]*>[^<]*<\/a>/gi) || [];
  console.log('\n   All anchor tags with text:');
  allAnchors.filter(a => !a.includes('Suchen') && !a.includes('static.xx') && a.length > 20).forEach(a => console.log(`     ${a.substring(0, 200)}`));

  throw new Error(`User "${query}" not found on mbasic`);
}

async function resolveUser(query) {
  // First try mbasic search (simpler, more reliable)
  try {
    return await resolveUserViaMbasic(query);
  } catch (e) {
    console.log(`\nmbasic resolution failed: ${e.message}`);
    console.log('Trying facebook.com with GraphQL...');
  }

  console.log(`\n=== Resolving user via main facebook.com: "${query}" ===`);

  // Step 1: Get tokens from facebook.com homepage
  console.log('1. Fetching facebook.com for tokens...');
  const home = await httpRequest('https://www.facebook.com/');
  console.log(`   Status: ${home.statusCode}, Body length: ${home.body.length}`);

  const dtsgMatch = home.body.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
    home.body.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
    home.body.match(/"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  const jazoestMatch = home.body.match(/name="jazoest"\s+value="(\d+)"/) || home.body.match(/"jazoest"\s*:\s*"(\d+)"/);
  const lsdMatch = home.body.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || home.body.match(/name="lsd"\s+value="([^"]+)"/);

  const fbDtsg = dtsgMatch?.[1] || '';
  const jazoest = jazoestMatch?.[1] || '';
  const lsd = lsdMatch?.[1] || '';
  console.log(`   fb_dtsg: ${fbDtsg ? fbDtsg.substring(0, 20) + '...' : 'NOT FOUND'}`);
  console.log(`   jazoest: ${jazoest || 'NOT FOUND'}`);
  console.log(`   lsd: ${lsd ? lsd.substring(0, 10) + '...' : 'NOT FOUND'}`);

  if (!fbDtsg) {
    console.log('   ⚠ Login page?', home.body.includes('/login/'));
    console.log('   Body preview:', home.body.substring(0, 500));
    throw new Error('No fb_dtsg token - session may be expired');
  }

  throw new Error(`User "${query}" not found`);
}

async function testMbasicSend(recipientId, message) {
  console.log(`\n=== Testing mbasic.facebook.com send ===`);
  console.log(`   Recipient ID: ${recipientId}`);
  console.log(`   Message: "${message}"`);

  const composeUrl = `https://mbasic.facebook.com/messages/compose/?ids=${recipientId}`;
  console.log(`\n3. Fetching compose page: ${composeUrl}`);

  const page = await httpRequest(composeUrl, { referer: 'https://mbasic.facebook.com/' });
  console.log(`   Status: ${page.statusCode}, Body length: ${page.body.length}`);

  if (page.body.includes('/login/') || page.body.includes('login_form')) {
    console.log('   ❌ Login page detected on mbasic!');
    console.log('   Body preview:', page.body.substring(0, 500));
    return false;
  }

  // Find form action
  const formMatch =
    page.body.match(/<form[^>]*action="(\/messages\/[^"]*)"[^>]*method="post"/i) ||
    page.body.match(/<form[^>]*method="post"[^>]*action="(\/messages\/[^"]*)"/i);

  if (!formMatch) {
    console.log('   ❌ No message form found!');
    // Look for any forms
    const allForms = page.body.match(/<form[^>]*>/gi) || [];
    console.log(`   Found ${allForms.length} forms total:`);
    allForms.forEach((f, i) => console.log(`     ${i}: ${f.substring(0, 150)}`));
    // Show a wider body snippet
    console.log('\n   Body snippet around "form":', page.body.substring(
      Math.max(0, page.body.indexOf('<form') - 100),
      page.body.indexOf('<form') + 500
    ));
    return false;
  }

  let formAction = formMatch[1].replace(/&amp;/g, '&');
  if (!formAction.startsWith('http')) formAction = `https://mbasic.facebook.com${formAction}`;
  console.log(`   Form action: ${formAction}`);

  // Extract hidden fields
  const params = new URLSearchParams();
  const hiddenRegex = /<input[^>]*type="hidden"[^>]*/gi;
  let m;
  const hiddenFields = [];
  while ((m = hiddenRegex.exec(page.body)) !== null) {
    const tag = m[0];
    const nameMatch = tag.match(/name="([^"]*)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (nameMatch) {
      const n = nameMatch[1].replace(/&amp;/g, '&');
      const v = valueMatch ? valueMatch[1].replace(/&amp;/g, '&') : '';
      params.append(n, v);
      hiddenFields.push(`${n}=${v.substring(0, 30)}`);
    }
  }
  console.log(`   Hidden fields (${hiddenFields.length}): ${hiddenFields.join(', ')}`);

  params.append('body', message);
  const submitMatch = page.body.match(/<input[^>]*name="send"[^>]*value="([^"]*)"/i);
  params.append('send', submitMatch ? submitMatch[1] : 'Senden');
  console.log(`   Submit button value: ${submitMatch ? submitMatch[1] : 'Senden (default)'}`);

  console.log('\n4. Submitting message form...');
  const response = await httpRequest(formAction, {
    method: 'POST',
    body: params.toString(),
    referer: composeUrl,
  });

  console.log(`   Response status: ${response.statusCode}`);
  console.log(`   Response body length: ${response.body.length}`);
  
  if (response.statusCode >= 400) {
    console.log(`   ❌ HTTP ${response.statusCode} error!`);
    console.log('   Body preview:', response.body.substring(0, 500));
    return false;
  }

  // Check if we got redirected to the conversation (success indicator)
  const hasError = response.body.includes('error') && response.body.includes('message');
  const hasThread = response.body.includes('/messages/read/') || response.body.includes('/messages/thread/');
  console.log(`   Has thread link (success indicator): ${hasThread}`);
  console.log(`   Has potential error: ${hasError}`);

  if (hasThread) {
    console.log('   ✅ Message appears to have been sent successfully!');
    return true;
  }

  console.log('   Body preview:', response.body.substring(0, 1000));
  return response.statusCode < 400;
}

async function main() {
  try {
    const username = 'Marie-Philine Herale';
    
    const recipientId = await resolveUser(username);
    console.log(`\n✅ Resolved "${username}" → ${recipientId}`);

    await testMbasicSend(recipientId, 'Hello');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

main();
