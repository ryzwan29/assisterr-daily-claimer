import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import * as solanaWeb3 from '@solana/web3.js';
import nacl from 'tweetnacl';
import chalk from 'chalk';
import { HttpsProxyAgent } from 'https-proxy-agent';

const ACCOUNTS_PATH = './accounts.txt';
const PROXY_PATH = './proxies.txt';

const log = (pubKey, message, type = 'info') => {
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, ' ').slice(0, 19);
    
    let messageColor, pubKeyColor;
    
    switch (type) {
        case 'success':
            messageColor = chalk.green;
            pubKeyColor = chalk.yellow;
            break;
        case 'error':
            messageColor = chalk.red;
            pubKeyColor = chalk.yellow;
            break;
        case 'warning':
            messageColor = chalk.yellow;
            pubKeyColor = chalk.yellow;
            break;
        case 'system':
            messageColor = chalk.cyan;
            pubKeyColor = chalk.yellow;
            break;
        default:
            messageColor = chalk.magenta;
            pubKeyColor = chalk.yellow;
    }
    
    if (type === 'system') {
        console.log(
            chalk.white('[') + 
            chalk.gray(timestamp) + 
            chalk.white('] ') + 
            messageColor(message)
        );
    } else {
        if (message.startsWith('Processing') && pubKey && pubKey !== 'UNKNOWN') {
            console.log(
                chalk.white('[') + 
                chalk.gray(timestamp) + 
                chalk.white('] ') + 
                messageColor('Processing ') + 
                pubKeyColor(pubKey)
            );
        } else {
            console.log(
                chalk.white('[') + 
                chalk.gray(timestamp) + 
                chalk.white('] ') + 
                messageColor(message)
            );
        }
    }
};

const readAccounts = () => {
    try {
        const data = fs.readFileSync(ACCOUNTS_PATH, 'utf8');
        return data.split('\n').filter(line => line.trim()).map(line => {
            const [token, refreshToken, privateKey] = line.split(':');
            return { token, refreshToken, privateKey };
        });
    } catch (error) {
        log('SYSTEM', `Error reading accounts: ${error.message}`, 'error');
        return [];
    }
};

const readProxy = () => {
    try {
        const data = fs.readFileSync(PROXY_PATH, 'utf8');
        return data.split('\n').filter(line => line.trim());
    } catch {
        return [];
    }
};

const updateAccountFile = (accounts) => {
    const content = accounts.map(acc => 
        `${acc.token}:${acc.refreshToken}:${acc.privateKey}`
    ).join('\n');
    fs.writeFileSync(ACCOUNTS_PATH, content);
};

const getPublicKey = (privateKey) => {
    if (!privateKey) return 'UNKNOWN';
    try {
        const cleanPrivateKey = privateKey.trim();
        const keypair = solanaWeb3.Keypair.fromSecretKey(bs58.decode(cleanPrivateKey));
        return keypair.publicKey.toString();
    } catch (error) {
        console.error(`Error decoding private key: ${error.message}`);
        return 'UNKNOWN';
    }
};

const customFetch = (proxy) => {
    return async (url, options = {}) => {
        if (proxy) {
            const agent = new HttpsProxyAgent(proxy);
            options.agent = agent;
        }
        return fetch(url, {
            ...options,
            headers: {
                'accept': 'application/json',
                'origin': 'https://build.assisterr.ai',
                'referer': 'https://build.assisterr.ai/',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...options.headers
            }
        });
    };
};

const getLoginMessage = async (fetchFn) => {
    const response = await fetchFn('https://api.assisterr.ai/incentive/auth/login/get_message/');
    return response.text();
};

const signLoginMessage = (message, privateKey) => {
    const encoder = new TextEncoder();
    const encodedMessage = encoder.encode(message);
    const keypair = solanaWeb3.Keypair.fromSecretKey(bs58.decode(privateKey));
    return {
        signature: bs58.encode(nacl.sign.detached(encodedMessage, keypair.secretKey)),
        publicKey: keypair.publicKey.toString()
    };
};

const handleLogin = async (fetchFn, message, privateKey) => {
    const { signature, publicKey } = signLoginMessage(message, privateKey);
    const response = await fetchFn('https://api.assisterr.ai/incentive/auth/login/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature, key: publicKey })
    });
    return response.json();
};

const handleTokenRefresh = async (fetchFn, refreshToken) => {
    const response = await fetchFn('https://api.assisterr.ai/incentive/auth/refresh_token/', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${refreshToken}` }
    });
    return response.json();
};

const claimDaily = async (fetchFn, token) => {
    const response = await fetchFn('https://api.assisterr.ai/incentive/users/me/daily_points/', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}` }
    });
    return response.json();
};

const checkUserStatus = async (fetchFn, token) => {
    const response = await fetchFn('https://api.assisterr.ai/incentive/users/me/', {
        headers: { 'authorization': `Bearer ${token}` }
    });
    return response.json();
};

const getUserMeta = async (fetchFn, token) => {
    const response = await fetchFn('https://api.assisterr.ai/incentive/users/me/meta/', {
        headers: { 'authorization': `Bearer ${token}` }
    });
    return response.json();
};

const processAccount = async (account, proxy) => {
    const fetchWithProxy = customFetch(proxy);
    const publicKey = getPublicKey(account.privateKey);
    
    try {
        let currentAccount = { ...account };
        log(publicKey, 'Processing', 'info');
        
        let userStatus = await checkUserStatus(fetchWithProxy, currentAccount.token);

        if (!userStatus?.id) {
            log('', 'Token expired, attempting refresh...', 'info');
            const refreshResult = await handleTokenRefresh(fetchWithProxy, currentAccount.refreshToken);
            
            if (refreshResult?.access_token) {
                currentAccount.token = refreshResult.access_token;
                currentAccount.refreshToken = refreshResult.refresh_token;
                log('', 'Token refreshed successfully', 'success');
                userStatus = await checkUserStatus(fetchWithProxy, currentAccount.token);
            } else {
                log('', 'Token refresh failed, attempting new login...', 'warning');
                const message = await getLoginMessage(fetchWithProxy);
                const loginResult = await handleLogin(fetchWithProxy, message.replace(/['"]/g, ''), currentAccount.privateKey);
                
                if (!loginResult.access_token) {
                    throw new Error('Login failed');
                }
                currentAccount.token = loginResult.access_token;
                currentAccount.refreshToken = loginResult.refresh_token;
                log('', 'New login successful', 'success');
            }
        }

        const meta = await getUserMeta(fetchWithProxy, currentAccount.token);
        if (meta?.daily_points_start_at) {
            const nextClaim = new Date(meta.daily_points_start_at);
            if (nextClaim > new Date()) {
                const timeUntil = Math.ceil((nextClaim - new Date()) / (1000 * 60));
                log('', `Next claim available in ${timeUntil} minutes`, 'info');
                return currentAccount;
            }
        }

        const claimResult = await claimDaily(fetchWithProxy, currentAccount.token);
        if (claimResult?.points) {
            log('', `Claim successful! Received ${claimResult.points} points`, 'success');
            const nextClaimTime = new Date(claimResult.daily_points_start_at);
            log('', `Next claim available at ${nextClaimTime.toLocaleString()}`, 'info');
        } else {
            log('', `Claim failed: ${JSON.stringify(claimResult)}`, 'error');
        }

        return currentAccount;
    } catch (error) {
        log('', `Error: ${error.message}`, 'error');
        return account;
    }
};

const main = async () => {
    console.log(chalk.cyan('Autoclaim Daily Started!\n'));
    
    const accounts = readAccounts();
    const proxies = readProxy();
    
    if (proxies.length > 0) {
        console.log(chalk.yellow(`Loaded ${proxies.length} proxies`));
    } else {
        console.log(chalk.red('No proxies found, using direct connection'));
    }
    
    console.log(chalk.magenta(`Processing ${accounts.length} accounts\n`));
    
    const updatedAccounts = [];

    for (let i = 0; i < accounts.length; i++) {
        const proxy = proxies.length ? proxies[i % proxies.length] : null;
        const updatedAccount = await processAccount(accounts[i], proxy);
        updatedAccounts.push(updatedAccount);
    }

    updateAccountFile(updatedAccounts);
    console.log('\n');  
    log('SYSTEM', 'All accounts processed, waiting for next cycle...', 'success');
    
    setTimeout(main, 3600000);
};

console.clear();
console.log(chalk.cyan(`
╔═══════════════════════════════════════════╗
║         Assisterr Daily Claimer           ║
║       https://github.com/im-hanzou        ║
╚═══════════════════════════════════════════╝
`));
main();
