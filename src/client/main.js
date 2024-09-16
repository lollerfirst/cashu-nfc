const fs = require('fs');
const path = require('path');
const { NFC } = require('nfc-pcsc');
const inquirer = require('inquirer');
const { CashuWallet } = require('@cashu/cashu-ts');
const qrcode = require('qrcode-terminal');
const bolt11 = require('bolt11');
const CBOR = require('cbor-js');
const { Buffer } = require('buffer'); 

// MIFARE Ultralight
const BLOCK_SIZE = 4;

// Load the configuration file
const configPath = path.join(__dirname, 'client.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Error loading configuration file: ${err}`);
  process.exit(1);
}

// Yoink token into credit card
async function dump_token(reader, mintUrl, proofs) {
    const bytesToken = CBOR.encode({
        'm': mintUrl,
        'p': proofs,
    });
    const size = bytesToken.length + (BLOCK_SIZE - (bytesToken.length % BLOCK_SIZE));
    const data = Buffer.alloc(size, 0);
    let written = data.write(bytesToken);
    if (written < size) {
        throw Error("Error while writing CBOR-encoded token to allocated buffer");
    }
    const lengthBuffer = Buffer.allocUnsafe(4);
    written = lengthBuffer.writeUInt32BE(bytesToken.length);
    if (written < size) {
        throw Error("Error while writing buffer size to allocated buffer");
    }
    await reader.write(0, lengthBuffer);    // block 0 (BLOCK_SIZE)
    await reader.write(1, data);            // block 1
}

// Load credit card
async function load_card(reader) {
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'method',
            message: 'ecash token or lightning?',
            choices: ['T', 'L']
        }
    ]);
    let proofs = [];
    let amountProofs = 0;
    // Swap received proofs
    if (answers.method === 'T') {
        const tokenAnswer = await inquirer.prompt(
            {
                type: 'input',
                name: 'token',
                message: 'Paste the cashu token:'
            },
        );
        proofs = await wallet.receive(tokenAnswer.token);
        amountProofs = proofs.reduce((acc, current) => acc + current.amount, 0);
    }
    // Mint new proofs
    else if (answers.method === 'L') {
        const invoiceAnswer = await inquirer.prompt([
            {
                type: 'input',
                name: 'amount',
                message: 'Please enter an amount in satoshis:',
                validate: (input) => {
                    const num = parseInt(input);
                    if (isNaN(num) || num <= 0) {
                        return 'Please enter a valid integer.';
                    }
                    return true;
                },
            }
        ]);
        amountProofs = parseInt(invoiceAnswer.amount);
        let mintQuote = await wallet.createMintQuote(amountProofs);
        const amountToPay = bolt11.decode(mintQuote.request)['satoshis'];
        console.log(`Please pay this lightning invoice for ${amountToPay} sats:`);
        qrcode.generate(mintQuote.request, (qrcode) => {
            console.log(qrcode);
        });
        while (mintQuote.state === 'UNPAID') {
            setTimeout(() => {
                console.log(`quote ${mintQuote.quote} still unpaid`);
            }, 1000);
            mintQuote = await wallet.checkMintQuote(mintQuote.quote);
        }
        if (mintQuote.state === 'ISSUED') {
            console.error("Mint quote was somehow already claimed!");
            throw Error("Mint quote was somehow already claimed!");
        }
        proofs = await wallet.mintTokens(amountProofs, mintQuote.quote);
    }
    else {
        throw Error("Invalid selection!");
    }

    await dump_token(reader, wallet.mint.mintUrl, proofs);
}
async function unload_card(reader){
    console.error("Not implemented!");
}
async function refresh_card(reader){
    console.error("Not implemented!");
}

// Create a new wallet
const wallet = new CashuWallet(config.mint);

// Create NFC listener
const nfc = new NFC();

// Scan for connected NFC devices
nfc.on('reader', (reader) => {
    console.log(`NFC reader connected: ${reader.name}`);
    reader.autoProcessing = false;

    // Set up the reader to scan for new NFC cards
    reader.on('card', async card => {
		console.log(`card detected: `, card);
        const answer = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'choice',
                    message: 'What do you want to do?',
                    choices: ['load', 'unload', 'refresh']
                }
            ]);
                  
        try{
            switch (answer.choice){
                case 'load':
                    await load_card(reader);
                    break;
                case 'unload':
                    await unload_card(reader);
                    break;
                case 'refresh':
                    await refresh_card(reader);
                    break;
                default:
                    console.error("Invalid option");
            }
        } catch (err) {
            console.error(`error when writing data`, err);
        }
    });

    // Set up behaviour when card is removed
    reader.on('card.off', card => {	
		console.log(`${reader.reader.name}  card removed`, card);
	});

    // Set up the reader to handle errors
    reader.on('error', (err) => {
        console.error(`NFC reader error: ${err}`);
    });

    // Behaviour when card reader is disconnected 
    reader.on('end', () => {
        console.log(`${reader.reader.name}  card removed`);
        process.exit(1);
    });
});

setInterval(() => {
    // Do nothing, just keep the program running
}, 1000);
  