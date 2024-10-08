# cashu-nfc 💳

cashu-nfc is a Node.js project composed of two separate applications: `client` and `merchant`. These applications operate on NFC cards to store and read ecash from them.

## Overview

* The `client` application allows users to charge up their NFC card with e-cash, and perform various operations such as topping up, withdrawing, refreshing, and resetting their card.
* The `merchant` application is designed to request payments from customers and store them in a SQLite database, simulating a cashier's cash drawer.

## Installation

### Linux
Run this to install required dependencies:
 ```bash
sudo apt install -y libnfc-bin pcscd pcsc-tools
```
Reload the pcsc service:
```bash
sudo systemctl restart pcscd.service
```
With the reader connected, check that the daemon is able to connect with it:
```bash
pcsc_scan
```
Then to install the project, navigate to the root directory and run:
```bash
npm install
```

>[!TIP]
> if your system has trouble detecting the reader,
> try this guide: https://andv.medium.com/how-to-fix-acr122s-and-libnfcs-unable-to-claim-usb-interface-on-kali-linux-932a34bb8e32

## Running the Applications

### Client

To run the client application, use the following command:
```bash
npm run client
```

The client application uses Inquirer to provide a menu-driven interface, allowing you to select from the following operations:

* `Top-up`: Add e-cash to your NFC card
* `Withdraw`: Remove e-cash from your NFC card
* `Refresh`: Swap old e-cash from your card and mint some fresh
* `Reset`: Erase the contents in the NFC card

### Merchant

To run the merchant application, use the following command:
```bash
npm run merchant
```

The merchant application allows you to:
* Request payments from customers through the `Request Payment` option and store them in the SQLite database, just like a cashier's cash drawer.
* Withdraw cash from the "drawer" as needed with the `Cash Out` option.

## Contribute

Contributions to cashu-nfc are welcome and greatly appreciated. By contributing to this project, you acknowledge that you are contributing to open source software and agree to the terms of the MIT License provided in this project.

By submitting a pull request or issue, you grant permission for your contribution to be licensed under the MIT License. This means that your contribution will be freely available for others to use, modify, and distribute, and you will not be entitled to any royalties or other compensation.
