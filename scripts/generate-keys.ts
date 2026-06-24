import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Generate Ed25519 key pair
// We use Ed25519 because the keys are much shorter than RSA and highly secure.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
    },
    privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
    }
});

const pubKeyPath = path.resolve('binance-public-key.pem');
const privKeyPath = path.resolve('binance-private-key.pem');

fs.writeFileSync(pubKeyPath, publicKey);
fs.writeFileSync(privKeyPath, privateKey);

console.log('✅ Keys generated successfully!');
console.log('----------------------------------------------------');
console.log('1️⃣ PUBLICA (Copie e cole na Binance):');
console.log(publicKey);
console.log('2️⃣ PRIVADA (Copie e coloque no BINANCE_API_SECRET da Render):');
console.log(privateKey);
console.log('----------------------------------------------------');
console.log(`Os arquivos também foram salvos no seu computador como:`);
console.log(`- ${pubKeyPath}`);
console.log(`- ${privKeyPath}`);
console.log(`\n⚠️ IMPORTANTE: A chave privada deve incluir os textos "-----BEGIN PRIVATE KEY-----" e "-----END PRIVATE KEY-----" ao colar na Render.`);
