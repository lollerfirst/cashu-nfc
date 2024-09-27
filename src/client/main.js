import fs from 'fs';
import { NFC } from 'nfc-pcsc';
import inquirer from 'inquirer';
import {
    CashuWallet,
    CashuMint,
    getDecodedToken,
    getEncodedTokenV4,
} from '@cashu/cashu-ts';
import {
    readCard,
    writeCard,
    resetCard,
    getMaxCapacity,
} from '../common/nfc.js';
import {
    sleep,
    compileToken,
} from '../common/helpers.js';
import process from 'node:process';
import qrcode from 'qrcode-terminal';
import bolt11 from 'bolt11';

// Load the configuration file
const configPath = 'src/client/client.json';
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.error(`Error loading configuration file: ${err}`);
    process.exit(1);
}

// Load credit card
async function loadCard(reader) {
    // Save previous balance
    let proofs = [];
    try {
        const tokenString = await readCard(reader);
        proofs = await wallet.receive(tokenString);
    } catch {
        proofs = [];
        console.log("Couldn't read previous balance. Assuming zero."); 
    }
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'method',
            message: 'ecash token or lightning?',
            choices: ['Token', 'Lightning']
        }
    ]);
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
        proofs = proofs.concat(await wallet.receive(tokenAnswer.token));
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
        const newProofs = await wallet.mintTokens(amountProofs, mintQuote.quote);
        proofs = proofs.concat(newProofs.proofs);
    }
    else {
        throw Error("Invalid selection!");
    }

    
    const token = compileToken(wallet.mint.mintUrl, 'sat', proofs);  
    //console.log(JSON.stringify(token.token[0].proofs, null, 2));
    const tokenString = getEncodedTokenV4(token);
    // Write token to card
    await writeCard(reader, tokenString);
}

// Pay a lightning invoice or output a token
async function unloadCard(reader){
    const tokenString = await readCard(reader);
    const token = getDecodedToken(tokenString);
    console.log(JSON.stringify(token.token[0].proofs, null, 2));
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
    const mint = token.token[0].mint;
    // Swap received proofs
    if (answers.method === 'Token') {
        if (mint !== wallet.mint.mintUrl) {
            console.warn(`Mint in the card (${mint}) is different than the wallet's mint (${wallet.mint.mintUrl})`);
        }
        proofs = await wallet.receive(token);
        const tokenString = getEncodedTokenV4(compileToken(mint, 'sat', proofs));
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
        console.log(`Invoice for ${decodedInvoice.satoshis} sats`);
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
        const tokenChange = getEncodedTokenV4(compileToken(mint, 'sat', change));
        await writeCard(reader, tokenChange);
    }
    else {
        throw Error("Invalid selection!");
    }
}

async function refreshCard(reader) {
    let tokenString = await readCard(reader);
    const proofs = await wallet.receive(tokenString);
    tokenString = getEncodedTokenV4(compileToken(wallet.mint.mintUrl, 'sat', proofs));
    await writeCard(reader, tokenString);
    console.log("Card Refreshed!");
}

async function deleteCard(reader) {
    const answer = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'conf',
            message: 'Are you sure about this?',
            default: false
        }
    ]);

    if (answer.conf == true) {
        console.log("Resetting card...");
        await resetCard(reader);
    }
}

async function getBalance(reader){
    const tokenString = await readCard(reader);
    const token = getDecodedToken(tokenString);
    return token.token[0].proofs.reduce((acc, curr) => acc + curr.amount, 0);
}

// Create a new wallet
const mint = new CashuMint(config.mint);
const wallet = new CashuWallet(mint, { unit:"sat" });
try {
    const mintInfo = await wallet.getMintInfo();
    console.log(`mintInfo: ${mintInfo.name} online!`);
} catch (err) {
    console.error(`Couldn't contact mint: ${err}`);
    process.exit(1);
}

// Create NFC listener
const nfc = new NFC();

// Scan for connected NFC devices
nfc.on('reader', (reader) => {
    console.log(`NFC reader connected: ${reader.name}`);
    reader.autoProcessing = false;

    // Set up the reader to scan for new NFC cards
    reader.on('card', async () => {
		console.log(`card detected`);
        const maxCapacity = await getMaxCapacity(reader);
        console.log(`maximum capacity: ${maxCapacity} bytes`);
        let isCard = true;

        // Set up behaviour when card is remove
        reader.on('card.off', () => {	
            console.log(`${reader.reader.name}  card removed`);
            isCard = false;
        });


        while (isCard) {
            let balance = 0;
            try{
                balance = await getBalance(reader);
            } catch {
                console.error("Could not get balance");
            }
            console.log(`BALANCE: ${balance} sats`);
            const answer = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'choice',
                        message: 'What do you want to do?',
                        choices: ['top-up', 'withdraw', 'refresh', 'reset', 'exit']
                    }
                ]);
                    
            try {
                switch (answer.choice){
                    case 'top-up':
                        await loadCard(reader);
                        break;
                    case 'withdraw':
                        await unloadCard(reader);
                        break;
                    case 'refresh':
                        await refreshCard(reader);
                        break;
                    case 'reset':
                        await deleteCard(reader);
                        break;
                    case 'exit':
                        process.exit(0);
                        break;
                    default:
                        console.error("Invalid option");
                }
                // await beepSuccess.play();
                console.log("Success!");
            } catch (err) {
                //await beepError.play();
                console.error(`Error during operation: `, err);
            }
        }
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