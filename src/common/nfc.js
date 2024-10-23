import { Buffer } from 'buffer';
import ndef from 'ndef';

// MIFARE Classic
const SECTOR_SIZE = 4;
const BLOCK_SIZE = 16;

// Dump proofs into credit card, prefixing them with the length of the BLOB.
export async function writeCard(reader, tokenString) {
    const record = ndef.uriRecord(tokenString);
    const ndefMessageBytes = ndef.encodeMessage([record]);
    const pad = (BLOCK_SIZE - (ndefMessageBytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
    const data = Buffer.concat([Buffer.from(ndefMessageBytes), Buffer.alloc(pad)]);
    let remainingLength = ndefMessageBytes.length + pad
    let block = 4; // Start from block 4
    let i = 0;
    try {
        while (remainingLength > 0) {
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1) {
                block += 1;
                continue;
            }
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x61, 'FFFFFFFFFFFF');
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

export async function readCard(reader) {
    // Read first block
    let block = 4;
    await reader.authenticate(block, 0x61, 'FFFFFFFFFFFF');
    let payload = await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
    try {
        while (true) {
            block += 1;
            // Skip trailing block
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1)
                continue;
            // Authenticate sector first block
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x61, 'FFFFFFFFFFFF');
            const piece = await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
            payload = Buffer.concat([payload, piece]);
        }
    } catch (err) {
        console.warn("\x1b[93m" + `Reading stopped at block ${block}: ${err}` + "\x1b[0m");
    }

    // https://www.oreilly.com/library/view/beginning-nfc/9781449324094/ch04.html
    // Chrome NDEFReader seems broken and does not respect this format structure.
    // Therefore the only option we have left is scan for an instance of "cashu"
    // inside the whole Buffer
    const tokenString = payload.toString();
    const cashuIndex = payload.indexOf("cashu");
    if (cashuIndex == -1) {
        throw new Error("This is not a Cashu token!");
    }
    console.log(`cashu index: ${cashuIndex}`);
    console.log(`header: ${JSON.stringify(payload.slice(0, cashuIndex))}`)
    console.log(`token: ${tokenString.substring(cashuIndex)}`);
    return tokenString.substring(cashuIndex, tokenString.length-1);
}

export async function resetCard(reader) {
    const emptyRecord = ndef.emptyRecord();
    const ndefMessageBytes = ndef.encodeMessage([emptyRecord]);
    const pad = (BLOCK_SIZE - (ndefMessageBytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
    const data = Buffer.concat([Buffer.from(ndefMessageBytes), Buffer.alloc(pad)]);
    let remainingLength = ndefMessageBytes.length + pad
    let block = 4; // Start from block 4
    let i = 0;
    try {
        while (remainingLength > 0) {
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1) {
                block += 1;
                continue;
            }
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x61, 'FFFFFFFFFFFF');
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

export async function getMaxCapacity(reader) {
    let block = 3;
    let capacity = 0;
    try {
        while (true) {
            block += 1;
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1)
                continue;
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x61, 'FFFFFFFFFFFF');
            await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
            capacity += BLOCK_SIZE;
        }
    } catch {
        return capacity;
    }
}