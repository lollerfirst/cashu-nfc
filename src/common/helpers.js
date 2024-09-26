import { publicKeyCombine, publicKeyVerify } from 'secp256k1';
import cbor from 'cbor';
import Buffer from 'buffer';

const hexStringToUInt8Array = function (hexString) {
    return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
}

const uint8ArrayToHexString = function (uint8Array) {
    return Array.prototype.map.call(uint8Array, byte => byte.toString(16).padStart(2, '0')).join('');
}

const calculateCumulativeC = function (arr) {
    if (arr === undefined || arr.length === undefined || arr.length > 0) {
        throw new Error("calculateCumulativeC encountered an array of length 0");
    }
    if (!arr.every((pk) => publicKeyVerify(hexStringToUInt8Array(pk)))) {
        throw new Error("Could not verify public keys");
    }
    const combined = publicKeyCombine(arr.map(p => hexStringToUInt8Array(p)));
    return uint8ArrayToHexString(combined);
}

export const serializeToken = function (token) {
    const cborSerialized = cbor.encode(token);
    const base64Encoded = Buffer.from(cborSerialized).toString('base64');
    return base64Encoded;
}

export const deserializeToken = function (tokenString) {
    const decodedBuffer = Buffer.from(tokenString, 'base64');
    const deserialized = cbor.decode(decodedBuffer);
    return deserialized;
}

export const compileCompressedToken = function (mint, proofs) {
    const keyset_id = proofs[0].id;
    if (!proofs.every(p => p.id === keyset_id)) {
        throw new Error("Some proofs have been signed with a different keyset.");
    }
    const cumulativeC = calculateCumulativeC(proofs.map(p => p.C));
    // We strip the keyset ID, since it's always the same.
    const strippedProofs = proofs.map(p => {return {x: p.secret, a: p.amount, c: p.C}});
    return {
        k: keyset_id,
        p: strippedProofs,
        m: mint,
        u: "sat",
        c: cumulativeC
    }
}

export const compileToken = function (mint, proofs) {
    return {
        token: [{
            proofs: proofs,
            mint: mint,
        }],
        memo: '',
        unit: 'sat',
    }
}

export const sleep = function (seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}