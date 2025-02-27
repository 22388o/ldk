import {
  BIP32Interface,
  networks,
  payments,
  crypto,
  address,
} from 'liquidjs-lib';
import { Slip77Interface, fromSeed } from 'slip77';

import { MultisigPayment } from './types';

/**
 * Create a P2MS redeemscript.
 * + conf address
 * + unconf address
 * @param keys co-signers public keys.
 * @param blindingKey
 * @param required number of signature required in multisig script.
 * @param network
 */
export function p2msPayment(
  keys: BIP32Interface[],
  blindingKey: Slip77Interface,
  required: number,
  network: networks.Network
): MultisigPayment {
  // first generate the unconfidential payment
  let multisigPayment = payments.p2wsh({
    redeem: payments.p2ms({
      m: parseInt(required.toString()), // this is a trick in case of the input returns a string at runtime
      pubkeys: bip67sort(keys.map(key => key.publicKey)),
      network,
    }),
    network,
  });

  if (!multisigPayment.address) throw new Error('Invalid payment');

  // generate blinding key
  const { publicKey, privateKey } = blindingKey.derive(
    address.toOutputScript(multisigPayment.address, network)
  );
  if (!publicKey || !privateKey)
    throw new Error('something went wrong while generating blinding key pair');

  multisigPayment = payments.p2wsh({
    redeem: payments.p2ms({
      m: parseInt(required.toString()), // this is a trick in case of the input returns a string at runtime
      pubkeys: bip67sort(keys.map(key => key.publicKey)),
      network,
    }),
    blindkey: publicKey,
    network,
  });

  if (
    !multisigPayment.confidentialAddress ||
    !multisigPayment.redeem ||
    !multisigPayment.redeem.output
  )
    throw new Error('invalid payment');

  return {
    blindingPrivateKey: privateKey.toString('hex'),
    confidentialAddress: multisigPayment.confidentialAddress,
    witnessScript: multisigPayment.redeem.output.toString('hex'),
  };
}

/**
 * Return a blinding key from a list of extended keys.
 * @param extendedKeys must be the first addresses of multi-sig stakeholders.
 */
export function blindingKeyFromXPubs(
  extendedKeys: BIP32Interface[]
): Slip77Interface {
  const chainCodes = extendedKeys.map(key => key.chainCode);
  const seed = blindingKeyFromChainCode(chainCodes);
  return fromSeed(seed);
}

/**
 * Returns sha256("blinding_key" + xor(chaincodes)) as a blinding key for multisig wallet.
 * https://github.com/cryptoadvance/specter-desktop/blob/master/src/cryptoadvance/specter/liquid/wallet.py#L77-L85
 * @param chainCodes the co-signers xpubs chainCodes (from the first receiving address)
 */
function blindingKeyFromChainCode(chainCodes: Buffer[]): Buffer {
  const prefix = Buffer.from('blinding_key');
  let chainCodesXOR = Buffer.alloc(32);
  for (const chainCode of chainCodes) {
    chainCodesXOR = xor(chainCodesXOR, chainCode);
  }

  return crypto.sha256(Buffer.concat([prefix, chainCodesXOR]));
}

// a xor b
function xor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) throw new Error('a.length !== b.length (xor)');

  const result = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i];
  }

  return result;
}

export function bip67sort(array: Buffer[]) {
  return array.sort(bip67compareFunction);
}

function bip67compareFunction(a: Buffer, b: Buffer): number {
  return a.toString('hex') < b.toString('hex') ? -1 : 1;
}
