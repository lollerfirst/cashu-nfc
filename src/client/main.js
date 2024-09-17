import fs from 'fs';
import path from 'path';
import { NFC } from 'nfc-pcsc';
import inquirer from 'inquirer';
import { CashuWallet, CashuMint } from '@cashu/cashu-ts';
import qrcode from 'qrcode-terminal';
import bolt11 from 'bolt11';
import CBOR from 'cbor-js';
import { Buffer } from 'buffer';
import Audic from 'audic';

// MIFARE Ultralight
const BLOCK_SIZE = 4;

// Load the configuration file
const configPath = 'src/client/client.json';
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.error(`Error loading configuration file: ${err}`);
    process.exit(1);
}

let beepSuccess, beepError;
if (config.sounds !== undefined){
    if (config.sounds.beep_success !== undefined) {
        beepSuccess = new Audic(config.sounds.beep_success);
    }
    if (config.sounds.beep_error !== undefined) {
        beepError = new Audic(config.sounds.beep_error);
    }
}

// Dump proofs into credit card, prefixing them with the length of the BLOB.
async function dump_token(reader, mintUrl, proofs) {
    const bytesToken = CBOR.encode({
        'm': mintUrl,
        'p': proofs,
    });
    const size = bytesToken.length + (BLOCK_SIZE - (bytesToken.length % BLOCK_SIZE));
    const data = Buffer.alloc(size, 0);
    let written = data.write(bytesToken);
    if (written < size) {
        throw new Error("Error while writing CBOR-encoded token to allocated buffer");
    }
    const lengthBuffer = Buffer.allocUnsafe(4);
    written = lengthBuffer.writeUInt32BE(bytesToken.length);
    if (written < size) {
        throw new Error("Error while writing buffer size to allocated buffer");
    }
    await reader.write(4, lengthBuffer);    // block 4 (first data block)
    await reader.write(5, data);            // block 5
    // (hopefully using write does not overwrite the trailer block of the sector)
}

async function read_token(reader) {
    const lengthBuffer = await reader.read(0, 4);
    const bytesToken = await reader.read(1, lengthBuffer.readUInt32BE(0));
    const token = CBOR.decode(bytesToken);
    return token;   
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
            throw new Error("Mint quote was somehow already claimed!");
        }
        proofs = await wallet.mintTokens(amountProofs, mintQuote.quote);
    }
    else {
        throw Error("Invalid selection!");
    }

    // Write token to card
    await dump_token(reader, wallet.mint.mintUrl, proofs);
}
async function unload_card(reader){
    
}
async function refresh_card(reader){
    console.error("Not implemented!");
}

// Create a new wallet
const wallet = new CashuWallet(config.mint, { unit:"sat" });
try {
    const mintInfo = await CashuMint.getInfo(config.mint);
    console.log(`mintInfo: ${mintInfo.name} online!`);
} catch (err) {
    console.error(`Couldn\'t contact mint: ${err}`);
    process.exit(1);
}


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
            //await beepError.play();
            console.error(`error when writing data`, err);
            return;
        }
        // await beepSuccess.play();
        console.log("Success!");
    });

    // Set up behaviour when card is removed
    reader.on('card.off', card => {	
		console.log(`${reader.reader.name}  card removed`, card);
	});

    // Set up the reader to handle errors
    reader.on('error', (err) => {
        //beepError.play().then();
        console.error(`NFC reader error: ${err}`);
    });

    // Behaviour when card reader is disconnected 
    reader.on('end', async () => {
        console.log(`${reader.reader.name}  card removed`);
        process.exit(1);
    });
});

nfc.on('error', err => {
    console.error(`Error occurred `, err);
});

setInterval(() => {
    // Do nothing, just keep the program running
}, 1000);
  