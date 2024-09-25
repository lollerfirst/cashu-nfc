// Helper functions
export const compileToken = function (mint, proofs) {
    return {
        token: [{
            proofs: proofs,
            mint: mint
        }],
        unit: "sat"
    }
}
export const sleep = function (seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}