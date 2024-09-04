import { ApiPromise } from '@polkadot/api';
import { KeyringPair } from '@polkadot/keyring/types';

export interface Transaction {
    id: string;
    from: string;
    to: string;
    amount: bigint;
    nonce: number;
    status: TransactionStatus;
    retryCount: number;
}

export interface Account {
    address: string;
    nonce: number;
    keyringPair: KeyringPair;
}

export enum TransactionStatus {
    Pending = 'PENDING',
    Submitted = 'SUBMITTED',
    Confirmed = 'CONFIRMED',
    Failed = 'FAILED',
}

export interface State {
    accounts: Account[];
    transactions: Transaction[];
    api: ApiPromise | null;
}
