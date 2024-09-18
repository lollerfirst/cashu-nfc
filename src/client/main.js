import fs from 'fs';
import path from 'path';
import { NFC } from 'nfc-pcsc';
import inquirer from 'inquirer';
import {
    CashuWallet,
    CashuMint,
    getDecodedToken,
    getEncodedToken,
    getEncodedTokenV4,
} from '@cashu/cashu-ts';

import qrcode from 'qrcode-terminal';
import bolt11 from 'bolt11';
import CBOR from 'cbor-js';
import { Buffer } from 'buffer';

// MIFARE Classic
const SECTOR_SIZE = 4;
const BLOCK_SIZE = 16;

// Load the configuration file
const configPath = 'src/client/client.json';
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.error(`Error loading configuration file: ${err}`);
    process.exit(1);
}


// Helper functions
function compileToken(mint, proofs) {
    return {
        token: [{
            proofs: proofs,
            mint: mint
        }],
        memo: "Cashu-NFC card token",
        unit: "sat"
    }
}
function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Dump proofs into credit card, prefixing them with the length of the BLOB.
async function dump_card(reader, tokenString) {
    // Prefix length to the 
    tokenString = tokenString.length.toString(16).padStart(4, '0') + tokenString;
    let remainingLength = tokenString.length + (BLOCK_SIZE - (tokenString.length % BLOCK_SIZE));
    console.log(`Trying to write ${remainingLength} bytes to card`);
    const data = Buffer.alloc(remainingLength, 0);
    let written = data.write(tokenString);
    if (written < tokenString.length) {
        throw new Error("Error while writing token string to allocated buffer");
    }
    let block = 4; // Start from block 4
    let i = 0;
    try {
        while (remainingLength > 0) {
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1) {
                block += 1;
                continue;
            }
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
            await reader.write(
                block,
                data.slice(
                    i*BLOCK_SIZE, 
                    (i+1)*BLOCK_SIZE
                ),
                BLOCK_SIZE
            );
            block += 1;
            i += 1;
            remainingLength -= BLOCK_SIZE;
        }
    } catch (err) {
        throw new Error(`Dumping to card failed at block ${block}: ${err}`);
    }
}

async function read_card(reader) {
     // Read first block
     let block = 4;
     await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
     let payload = await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
     let payloadString = payload.toString();
     let remainingSize = parseInt(payloadString.substring(0,4), 16) - BLOCK_SIZE + 4;
     console.log(`remaining token size: ${remainingSize}`)
     try {
        while (remainingSize > 0) {
            block += 1;
            // Skip trailing block
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1)
                continue;
            // Authenticate sector first block;
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
            payload = await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
            payloadString += payload.toString();
            remainingSize -= BLOCK_SIZE;
        }
    } catch (err) {
        throw new Error(`Error reading from card at block ${block}: ${err}`);
    }
     console.log(`read token size: ${payloadString.length}`);

     return payloadString.substr(4);
}

// Load credit card
async function load_card(reader) {
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'method',
            message: 'ecash token or lightning?',
            choices: ['Token', 'Lightning']
        }
    ]);
    let proofs = [];
    let amountProofs = 0;
    // Swap received proofs
    if (answers.method === 'Token') {
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
    else if (answers.method === 'Lightning') {
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
        qrcode.generate(mintQuote.request, { small: true }, (qrcode) => {
            console.log(qrcode);
        });
        while (mintQuote.state === 'UNPAID') {
            await sleep(1);
            mintQuote = await wallet.checkMintQuote(mintQuote.quote);
        }
        if (mintQuote.state === 'ISSUED') {
            console.error("Mint quote was somehow already claimed!");
            throw new Error("Mint quote was somehow already claimed!");
        }
        console.log("Invoice PAID!");
        proofs = await wallet.mintTokens(amountProofs, mintQuote.quote);
    }
    else {
        throw Error("Invalid selection!");
    }

    const tokenString = getEncodedTokenV4(compileToken(wallet.mint.mintUrl, proofs));
    // Write token to card
    await dump_card(reader, tokenString);
}

// Pay a lightning invoice or output a token
async function unload_card(reader){
    const tokenString = await read_card(reader);
    const token = getDecodedToken(tokenString);
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'method',
            message: 'ecash token or lightning invoice?',
            choices: ['Token', 'Lightning']
        }
    ]);
    let proofs = token.token[0].proofs;
    let amountProofs = proofs.reduce((acc, current) => acc + current.amount, 0);
    const mint = token.token[0].mint;;
    // Swap received proofs
    if (answers.method === 'Token') {
        if (mint !== wallet.mint.mintUrl) {
            console.warn(`Mint in the card (${mint}) is different than the wallet's mint (${wallet.mint.mintUrl})`);
        }
        proofs = await wallet.receive(token);
        const tokenString = getEncodedTokenV4(compileToken(mint, proofs));
        console.log(`Cashu token for ${amountProofs} sats:`);
        console.log(tokenString);
        qrcode.generate(tokenString, { small: true },  (qr) => {
            console.log(qr);
        })
    }
    // Melt proofs
    else if (answers.method === 'Lightning') {
        const invoiceAnswer = await inquirer.prompt([
            {
                type: 'input',
                name: 'invoice',
                message: 'Please enter a BOLT11 invoice:'
            }
        ]);
        const decodedInvoice = bolt11.decode(invoiceAnswer.invoice);
        const tokenAmount = token.token[0].proofs.reduce((acc, curr) =>  acc + curr.amount, 0);
        if (tokenAmount < decodedInvoice.satoshis) {
            throw new Error("Card limit exceeded");
        }
        const meltQuote = await wallet.createMeltQuote(invoiceAnswer.invoice);
        const payAmount = meltQuote.amount + meltQuote.fee_reserve;
        if (tokenAmount < payAmount) {
            throw new Error("Card limit exceeded (with fees)");
        }
        const { isPaid, preimage, change } = await wallet.meltTokens(meltQuote, token.token[0].proofs);
        if (!isPaid) {
            throw new Error("Error while paying the invoice");
        }
        console.log(`Payment success: ${preimage}`);
        tokenChange = getEncodedTokenV4(compileToken(mint, change));
        await dump_card(reader, tokenChange);
    }
    else {
        throw Error("Invalid selection!");
    }
}
async function refresh_card(reader){
    console.error("Not implemented!");
}

// Create a new wallet
const mint = new CashuMint(config.mint);
const wallet = new CashuWallet(mint, { unit:"sat" });
try {
    const mintInfo = await CashuMint.getInfo(config.mint);
    console.log(`mintInfo: ${mintInfo.name} online!`);
} catch (err) {
    console.error(`Couldn\'t contact mint: ${err}`);
    process.exit(1);
}

// Create NFC listener
const nfc = new NFC(console);

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
                    choices: ['top-up', 'withdraw', 'refresh']
                }
            ]);
                  
        try{
            switch (answer.choice){
                case 'top-up':
                    await load_card(reader);
                    break;
                case 'withdraw':
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
		console.log(`${reader.reader.name}  card removed`);
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
  