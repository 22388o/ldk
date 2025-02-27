import * as assert from 'assert';
import { fromSeed as bip32fromSeed } from 'bip32';
import { mnemonicToSeedSync } from 'bip39';
import {
  Psbt,
  Transaction,
  confidential,
  networks,
  payments,
  address,
  TxOutput,
} from 'liquidjs-lib';
import { BlindingDataLike } from 'liquidjs-lib/types/psbt';
import { fromSeed as slip77fromSeed } from 'slip77';

import {
  IdentityOpts,
  IdentityType,
  Mnemonic,
  MnemonicOpts,
  mnemonicRestorerFromEsplora,
  mnemonicRestorerFromState,
  StateRestorerOpts,
} from '../src';

import { Restorer } from '../src';
import { faucet, fetchTxHex, fetchUtxos } from './_regtest';

const network = networks.regtest;

jest.setTimeout(500_000);

const validOpts: IdentityOpts<MnemonicOpts> = {
  chain: 'regtest',
  type: IdentityType.Mnemonic,
  opts: {
    mnemonic:
      'turn manual grain tobacco pluck onion off chief drive amount slice forward',
  },
};

const seedFromValidMnemonic = mnemonicToSeedSync(validOpts.opts.mnemonic);
const masterPrivateKeyFromValidMnemonic = bip32fromSeed(
  seedFromValidMnemonic,
  network
);
const masterBlindingKeyFromValidMnemonic = slip77fromSeed(
  seedFromValidMnemonic
);

const validOptsFrench: IdentityOpts<MnemonicOpts> = {
  ...validOpts,
  opts: {
    mnemonic:
      'mutuel ourson soupape vertu atelier dynastie silicium absolu océan légume pyramide skier météore tulipe alchimie élargir gourmand étaler saboter cocotier aisance mairie jeton créditer',
    language: 'french',
  },
};

const unvalidLanguageOpts: IdentityOpts<MnemonicOpts> = {
  ...validOpts,
  opts: {
    ...validOpts.opts,
    language: 'corsican',
  },
};

const unvalidTypeOpts: IdentityOpts<MnemonicOpts> = {
  ...validOpts,
  type: IdentityType.PrivateKey,
};

const unvalidMnemonicOpts: IdentityOpts<MnemonicOpts> = {
  ...validOpts,
  opts: {
    mnemonic: 'tbh nigiri is awesome for Liquid / bitcoin unit testing',
  },
};

describe('Identity: Mnemonic', () => {
  describe('Constructor', () => {
    const validMnemonic = new Mnemonic(validOpts);

    it('should build a valid Mnemonic class if the constructor arguments are valid', () => {
      assert.deepStrictEqual(validMnemonic instanceof Mnemonic, true);
    });

    it('should generate a slip77 master blinding key and a bip32 master private key from the mnemonic', () => {
      assert.deepStrictEqual(
        validMnemonic.masterBlindingKeyNode.privateKey,
        masterBlindingKeyFromValidMnemonic.privateKey
      );
      assert.deepStrictEqual(
        validMnemonic.masterPrivateKeyNode.privateKey,
        masterPrivateKeyFromValidMnemonic.privateKey
      );
    });

    it('should work if a language is specified', () => {
      const frenchMnemonic = new Mnemonic(validOptsFrench);
      assert.deepStrictEqual(frenchMnemonic instanceof Mnemonic, true);
    });

    it('should throw an error if type is not IdentityType.Mnemonic', () => {
      assert.throws(() => new Mnemonic(unvalidTypeOpts));
    });

    it('should throw an error if the language is unvalid (i.e has no wordlist available)', () => {
      assert.throws(() => new Mnemonic(unvalidLanguageOpts));
    });

    it('should throw an error if the mnemonic is unvalid', () => {
      assert.throws(() => new Mnemonic(unvalidMnemonicOpts));
    });
  });

  describe('Mnemonic.isAbleToSign', () => {
    it('should return true', () => {
      const mnemonic = new Mnemonic(validOpts);
      assert.deepStrictEqual(mnemonic.isAbleToSign(), true);
    });
  });

  describe('Mnemonic.signPset', () => {
    it('should sign the inputs of the previously generated addresses', async () => {
      const mnemonic = new Mnemonic(validOpts);
      const generated = await mnemonic.getNextAddress();

      const { unconfidentialAddress } = address.fromConfidential(
        generated.confidentialAddress
      );
      const txid = await faucet(unconfidentialAddress);
      const utxo = (await fetchUtxos(unconfidentialAddress)).find(
        u => u.txid === txid
      );

      const prevoutHex = await fetchTxHex(utxo.txid);
      const prevout = Transaction.fromHex(prevoutHex).outs[utxo.vout];

      const script: Buffer = address.toOutputScript(unconfidentialAddress);

      const pset: Psbt = new Psbt({ network })
        .addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: prevout,
        })
        .addOutputs([
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(49999500),
            script,
            asset: network.assetHash,
          },
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(60000000),
            script: Buffer.alloc(0),
            asset: network.assetHash,
          },
        ]);

      const signedBase64 = await mnemonic.signPset(pset.toBase64());
      const signedPsbt = Psbt.fromBase64(signedBase64);
      let isValid = false;
      assert.doesNotThrow(
        () => (isValid = signedPsbt.validateSignaturesOfAllInputs())
      );
      assert.deepStrictEqual(isValid, true);
    });
  });

  describe('Mnemonic.blindPset', () => {
    it('should blind the transaction', async () => {
      const mnemonic = new Mnemonic(validOpts);
      const generated = await mnemonic.getNextAddress();

      const txid = await faucet(generated.confidentialAddress);
      const utxo = (await fetchUtxos(generated.confidentialAddress)).find(
        u => u.txid === txid
      );

      const prevoutHex = await fetchTxHex(utxo.txid);
      const prevout = Transaction.fromHex(prevoutHex).outs[utxo.vout];
      const unblindedPrevout = await confidential.unblindOutputWithKey(
        prevout as TxOutput,
        Buffer.from(
          await mnemonic.getBlindingPrivateKey(prevout.script.toString('hex')),
          'hex'
        )
      );

      const script: Buffer = payments.p2wpkh({
        confidentialAddress: generated.confidentialAddress,
        network,
      }).output!;

      const pset: Psbt = new Psbt({ network })
        .addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: prevout,
        })
        .addOutputs([
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(49999500),
            script,
            asset: network.assetHash,
          },
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(60000000),
            script: Buffer.alloc(0),
            asset: network.assetHash,
          },
        ]);

      const blindBase64 = await mnemonic.blindPset(
        pset.toBase64(),
        [0],
        undefined,
        new Map<number, BlindingDataLike>().set(0, unblindedPrevout)
      );
      const signedBase64 = await mnemonic.signPset(blindBase64);
      const signedPsbt = Psbt.fromBase64(signedBase64);
      let isValid = false;
      assert.doesNotThrow(
        () => (isValid = signedPsbt.validateSignaturesOfAllInputs())
      );
      assert.deepStrictEqual(isValid, true);
    });

    it('should throw an error if one of the output to blind does not contain blinding public key (and it is not an identity script)', async () => {
      const mnemonic = new Mnemonic(validOpts);
      const generated = await mnemonic.getNextAddress();

      await faucet(generated.confidentialAddress);
      const utxo = (await fetchUtxos(generated.confidentialAddress))[0];

      const prevoutHex = await fetchTxHex(utxo.txid);
      const prevout = Transaction.fromHex(prevoutHex).outs[utxo.vout];

      const script = Buffer.from(
        '00140619adc71daf50734f660bb2ee9aef37825b81fe',
        'hex'
      ); // non wallet script

      const pset: Psbt = new Psbt({ network })
        .addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: prevout,
        })
        .addOutputs([
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(49999500),
            script,
            asset: network.assetHash,
          },
          {
            nonce: Buffer.from('00', 'hex'),
            value: confidential.satoshiToConfidentialValue(60000000),
            script: Buffer.alloc(0),
            asset: network.assetHash,
          },
        ]);

      assert.rejects(mnemonic.blindPset(pset.toBase64(), [0]));
    });
  });

  describe('Mnemonic.getAddresses', () => {
    it('should have private method getAddress return an AddressInterfaceExtended', () => {
      const mnemonic = new Mnemonic(validOpts);
      const addressExtended = mnemonic['getAddress'](false, 42);
      assert.deepStrictEqual(addressExtended, {
        address: {
          blindingPrivateKey:
            '3ca8245e4b3e938cfe78ae124767b3e277ac7eb786cc9b305750efb7a2da150c',
          confidentialAddress:
            'el1qqwk073ahg84zn02x4l6rvwdrtrpgs9ufukgppqshs3hhvq0e9e8rzdsths666g8h5xhxj696axjydx83ep2jj3wtxx5cl8gcp',
          derivationPath: "m/84'/0'/0'/0/42",
        },
        publicKey:
          '0212c8b6bea7e0061f41d16ec5b4c18f51335e133f3f4037af66d058c6e3bc9ecb',
      });
    });

    it('should return all the generated addresses', async () => {
      const mnemonic = new Mnemonic(validOpts);
      const generated1 = await mnemonic.getNextAddress();
      const generated2 = await mnemonic.getNextAddress();
      assert.deepStrictEqual(
        [generated1, generated2],
        await mnemonic.getAddresses()
      );
    });
  });

  describe('Mnemonic.getBlindingPrivateKey', () => {
    it('should return the privateKey according to slip77 spec', async () => {
      const mnemonic = new Mnemonic(validOpts);
      const {
        confidentialAddress,
        blindingPrivateKey,
      } = await mnemonic.getNextAddress();

      const script: string = payments
        .p2wpkh({
          confidentialAddress,
          network,
        })
        .output!.toString('hex');

      assert.deepStrictEqual(
        await mnemonic.getBlindingPrivateKey(script),
        blindingPrivateKey
      );
    });
  });
  describe('Mnemonic restoration', () => {
    describe('Mnemonic restoration (from Esplora)', () => {
      let mnemonic: Mnemonic;
      let restoredMnemonic: Mnemonic;

      beforeAll(async () => {
        const numberOfAddresses = 21;
        mnemonic = new Mnemonic(validOpts);
        // faucet all the addresses
        for (let i = 0; i < numberOfAddresses; i++) {
          const addr = await mnemonic.getNextAddress();
          const changeAddr = await mnemonic.getNextChangeAddress();
          if (i === numberOfAddresses - 1) {
            await faucet(addr.confidentialAddress);
            await faucet(changeAddr.confidentialAddress);
          }
        }
        const toRestoreMnemonic = new Mnemonic({
          ...validOpts,
        });
        restoredMnemonic = await mnemonicRestorerFromEsplora(toRestoreMnemonic)(
          {
            gapLimit: 30,
            esploraURL: 'http://localhost:3001',
          }
        );
      });

      it('should restore already used addresses', async () => {
        const addrs = await mnemonic.getAddresses();
        const restored = await restoredMnemonic.getAddresses();
        assert.deepStrictEqual(addrs.length, restored.length);
      });

      it('should update the index when restored', async () => {
        const toRestoreAddrs = await restoredMnemonic.getAddresses();
        const addressesKnown = toRestoreAddrs.map(a => a.confidentialAddress);

        const next = await restoredMnemonic.getNextAddress();
        const nextIsAlreadyKnownByMnemonic = addressesKnown.includes(
          next.confidentialAddress
        );

        assert.deepStrictEqual(nextIsAlreadyKnownByMnemonic, false);
      });

      it('should update the change index when restored', async () => {
        const toRestoreAddrs = await restoredMnemonic.getAddresses();
        const addressesKnown = toRestoreAddrs.map(a => a.confidentialAddress);

        const next = await restoredMnemonic.getNextChangeAddress();
        const nextIsAlreadyKnownByMnemonic = addressesKnown.includes(
          next.confidentialAddress
        );

        assert.deepStrictEqual(nextIsAlreadyKnownByMnemonic, false);
      });
    });

    describe('Mnemonic restoration (from State)', () => {
      const restorer: Restorer<StateRestorerOpts, Mnemonic> = args => {
        const toRestoreMnemonic = new Mnemonic({
          ...validOpts,
        });
        return mnemonicRestorerFromState(toRestoreMnemonic)(args);
      };

      it('should update the index when restored', async () => {
        const restored = await restorer({
          lastUsedExternalIndex: 15,
          lastUsedInternalIndex: 4,
        });

        assert.deepStrictEqual(
          (await restored.getNextAddress()).derivationPath,
          "m/84'/0'/0'/0/16"
        );
      });

      it('should update the change index when restored', async () => {
        const restored = await restorer({
          lastUsedExternalIndex: 15,
          lastUsedInternalIndex: 4,
        });

        assert.deepStrictEqual(
          (await restored.getNextChangeAddress()).derivationPath,
          "m/84'/0'/0'/1/5"
        );
      });

      it('should update indexes when no internalIndex', async () => {
        const restored = await restorer({
          lastUsedExternalIndex: 10,
        });
        assert.deepStrictEqual(
          (await restored.getNextAddress()).derivationPath,
          "m/84'/0'/0'/0/11"
        );
        assert.deepStrictEqual(
          (await restored.getNextChangeAddress()).derivationPath,
          "m/84'/0'/0'/1/0"
        );
      });

      it('should update indexes when no externalIndex', async () => {
        const restored = await restorer({
          lastUsedInternalIndex: 10,
        });

        assert.deepStrictEqual(
          (await restored.getNextAddress()).derivationPath,
          "m/84'/0'/0'/0/0"
        );
        assert.deepStrictEqual(
          (await restored.getNextChangeAddress()).derivationPath,
          "m/84'/0'/0'/1/11"
        );
      });

      it('should update indexes when no internalIndex and externalIndex', async () => {
        const restored = await restorer({});
        assert.deepStrictEqual(
          (await restored.getNextAddress()).derivationPath,
          "m/84'/0'/0'/0/0"
        );
        assert.deepStrictEqual(
          (await restored.getNextChangeAddress()).derivationPath,
          "m/84'/0'/0'/1/0"
        );
      });

      it('should not return addresses when no internalIndex and externalIndex', async () => {
        const restored = await restorer({});
        assert.deepStrictEqual(await restored.getAddresses(), []);
      });
    });
  });
});
