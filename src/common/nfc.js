import { Buffer } from 'buffer';

// MIFARE Classic
const SECTOR_SIZE = 4;
const BLOCK_SIZE = 16;

// Dump proofs into credit card, prefixing them with the length of the BLOB.
export async function writeCard(reader, tokenString) {
    // Prefix length
    const hexLength = tokenString.length.toString(16).padStart(4, '0');
    //console.log(`Dumping hex length token: ${hexLength}`);
    //console.log(`tokenString: ${tokenString}`);
    tokenString = hexLength + tokenString;
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

export async function readCard(reader) {
    // Read first block
    let block = 4;
    await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
    let payload = await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
    let payloadString = payload.toString();
    let remainingSize = parseInt(payloadString.substring(0,4), 16) - BLOCK_SIZE + 4;
    // console.log(`remaining token size: ${remainingSize}`)
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
    //console.log(`read token: ${payloadString.substr(4)}`);

    return payloadString.substr(4);
}

export async function resetCard(reader) {
    let block = 3;
    const zeros = Buffer.alloc(BLOCK_SIZE, 0);
    try {
        while (true) {
            block += 1;
            if (block % SECTOR_SIZE == SECTOR_SIZE - 1)
                continue;
            if (block % SECTOR_SIZE == 0)
                await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
            await reader.write(block, zeros, BLOCK_SIZE);
        }
    } catch (err) {
        console.log(`Reset stopped at block ${block}. Reason: ${err}`);
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
                await reader.authenticate(block, 0x60, 'FFFFFFFFFFFF');
            await reader.read(block, BLOCK_SIZE, BLOCK_SIZE);
            capacity += BLOCK_SIZE;
        }
    } catch {
        return capacity;
    }
}