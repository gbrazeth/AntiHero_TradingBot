import crypto from 'node:crypto';

const apiKey = 'EuVXlIQRlOc7zQ89Ts';
const apiSecret = 'NvqOGKfvc5EKMbe6ITE009SwsxwCfZBOAeuv';

async function testEndpoint(baseUrl: string) {
    console.log(`Testing ${baseUrl} ...`);
    
    const pathWithQuery = '/v5/account/wallet-balance?accountType=UNIFIED';
    const qs = pathWithQuery.split('?')[1];
    
    const timestamp = Date.now().toString();
    const recvWindow = '10000';
    const payload = `${timestamp}${apiKey}${recvWindow}${qs}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

    try {
        const res = await fetch(`${baseUrl}${pathWithQuery}`, {
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'X-BAPI-SIGN': signature
            }
        });
        const data = await res.json();
        console.log(`Response from ${baseUrl}:`, data.retCode === 0 ? '✅ SUCCESS' : `❌ FAILED: [${data.retCode}] ${data.retMsg}`);
        if(data.retCode === 0) console.log(JSON.stringify(data.result, null, 2));
    } catch (e) {
        console.error(`Error connecting to ${baseUrl}:`, e);
    }
}

async function run() {
    await testEndpoint('https://api-testnet.bybit.com');
}

run();
