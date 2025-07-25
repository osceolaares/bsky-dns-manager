const { Route53 } = require('@aws-sdk/client-route-53');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID;
const DOMAIN = process.env.DNS_DOMAIN;
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const route53 = new Route53();

// Returns all TXT values for a record as an array of { Value: ... } objects, or [] if not found
async function getTxtRecord(name) {
  const params = {
    HostedZoneId: HOSTED_ZONE_ID,
    StartRecordName: name,
    StartRecordType: 'TXT',
    MaxItems: '1',
  };
  const data = await route53.listResourceRecordSets(params);
  const record = data.ResourceRecordSets.find(r => r.Name.replace(/\.$/, '') === name && r.Type === 'TXT');
  if (record && record.ResourceRecords.length > 0) {
    return record.ResourceRecords.map(r => ({ Value: r.Value }));
  }
  return [];
}

function isValidDidFormat(did) {
  return /^did:plc:[a-z0-9]{24}$/.test(did);
}

async function isValidDidPlc(did) {
  try {
    const resp = await axios.get(`https://plc.directory/${did}`);
    return resp.status === 200 && resp.data && resp.data.id === did;
  } catch {
    return false;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,DELETE'
};

exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event));
  const method = event.httpMethod;
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (err) { console.error('Error parsing body:', err); }
  }
  const query = event.queryStringParameters || {};

  if (method === 'POST') {
    const { token, did, hostname } = body;
    console.log('POST request body:', body);
    if (!token || !did || !hostname) {
      console.warn('Missing fields:', { token, did, hostname });
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    if (!isValidDidFormat(did)) {
      console.warn('Invalid DID format:', did);
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid DID format' }) };
    }
    if (!(await isValidDidPlc(did))) {
      console.warn('DID not found in PLC directory:', did);
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'DID not found in PLC directory' }) };
    }
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
      const user = ticket.getPayload();
      console.log('Authenticated user:', user);
      const fqdn = `${hostname}.${DOMAIN}`;
      const atprotoFqdn = `_atproto.${hostname}.${DOMAIN}`;
      const ownerTxtArr = await getTxtRecord(fqdn);
      const ownerTxt = ownerTxtArr.length > 0 ? ownerTxtArr[0].Value.replace(/^"|"$/g, '') : null;
      console.log('Existing ownerTxt:', ownerTxt);
      if (ownerTxt && ownerTxt !== user.sub) {
        console.warn('Not authorized to update entry:', { ownerTxt, userSub: user.sub });
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Not authorized to update this entry' }) };
      }
      const changes = [
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: atprotoFqdn,
            Type: 'TXT',
            TTL: 300,
            ResourceRecords: [{ Value: `"did=${did}"` }],
          },
        },
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: fqdn,
            Type: 'TXT',
            TTL: 300,
            ResourceRecords: [{ Value: `"${user.sub}"` }],
          },
        },
      ];
      const params = { HostedZoneId: HOSTED_ZONE_ID, ChangeBatch: { Changes: changes } };
      console.log('Route53 change params:', params);
      await route53.changeResourceRecordSets(params);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
    } catch (err) {
      console.error('POST error:', err);
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid token or AWS error', details: err.message }) };
    }
  }

  if (method === 'DELETE') {
    const { token, hostname } = body;
    console.log('DELETE request body:', body);
    if (!token || !hostname) {
      console.warn('Missing fields:', { token, hostname });
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
      const user = ticket.getPayload();
      console.log('Authenticated user:', user);
      const fqdn = `${hostname}.${DOMAIN}`;
      const atprotoFqdn = `_atproto.${hostname}.${DOMAIN}`;
      const fqdnTxtRecords = await getTxtRecord(fqdn);
      const ownerTxt = fqdnTxtRecords.length > 0 ? fqdnTxtRecords[0].Value.replace(/^"|"$/g, '') : null;
      console.log('Existing ownerTxt:', ownerTxt);
      if (!ownerTxt || ownerTxt !== user.sub) {
        console.warn('Not authorized or entry does not exist:', { ownerTxt, userSub: user.sub });
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Not authorized or entry does not exist' }) };
      }
      // Use getTxtRecord for both records
      const atprotoTxtRecords = await getTxtRecord(atprotoFqdn);
      const changes = [];
      if (atprotoTxtRecords.length > 0) {
        changes.push({
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: atprotoFqdn,
            Type: 'TXT',
            TTL: 300,
            ResourceRecords: atprotoTxtRecords,
          },
        });
      }
      if (fqdnTxtRecords.length > 0) {
        changes.push({
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: fqdn,
            Type: 'TXT',
            TTL: 300,
            ResourceRecords: fqdnTxtRecords,
          },
        });
      }
      if (changes.length === 0) {
        console.warn('No matching TXT records found to delete.');
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'No matching TXT records found to delete.' }) };
      }
      const params = { HostedZoneId: HOSTED_ZONE_ID, ChangeBatch: { Changes: changes } };
      console.log('Route53 change params:', params);
      await route53.changeResourceRecordSets(params);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
    } catch (err) {
      console.error('DELETE error:', err);
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid token or AWS error', details: err.message }) };
    }
  }

  if (method === 'GET') {
    const { token } = query;
    console.log('GET request query:', query);
    if (!token) {
      console.warn('Missing token in GET request');
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing token' }) };
    }
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
      const user = ticket.getPayload();
      console.log('Authenticated user:', user);
      let allRecords = [];
      let params = {
        HostedZoneId: HOSTED_ZONE_ID,
        MaxItems: '100',
      };
      let hasMore = true;
      while (hasMore) {
        const data = await route53.listResourceRecordSets(params);
        allRecords = allRecords.concat(data.ResourceRecordSets);
        if (data.NextRecordName) {
          params.StartRecordName = data.NextRecordName;
          if (data.NextRecordType) params.StartRecordType = data.NextRecordType;
          if (data.NextRecordIdentifier) params.StartRecordIdentifier = data.NextRecordIdentifier;
        } else {
          hasMore = false;
        }
      }
      console.log('Route53 all ResourceRecordSets count:', allRecords.length);
      const userEntries = allRecords
        .filter(r => r.Type === 'TXT' && r.ResourceRecords.some(rec => rec.Value.replace(/^"|"$/g, '') === user.sub))
        .map(r => {
          const hostname = r.Name.replace(`.${DOMAIN}.`, '').replace(/\.$/, '');
          // Find the corresponding _atproto TXT record
          const atprotoName = `_atproto.${hostname}.${DOMAIN}.`;
          const atprotoRecord = allRecords.find(
            rec => rec.Name === atprotoName && rec.Type === 'TXT'
          );
          let did = null;
          if (atprotoRecord && atprotoRecord.ResourceRecords.length > 0) {
            const match = atprotoRecord.ResourceRecords[0].Value.match(/did=([^\"]+)/);
            if (match) did = match[1];
          }
          return { hostname, did };
        });
      console.log('User entries:', userEntries);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(userEntries) };
    } catch (err) {
      console.error('GET error:', err);
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid token', details: err.message }) };
    }
  }

  return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
