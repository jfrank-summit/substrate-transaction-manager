import { updateState, getState } from './store';
import { Transaction, TransactionStatus, Account } from './types';
import { ApiPromise } from '@polkadot/api';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import { WsProvider } from '@polkadot/rpc-provider';

let currentAccountIndex = 0;

const getNextAccount = (): Account | undefined => {
    const state = getState();
    if (state.accounts.length === 0) return undefined;
    const account = state.accounts[currentAccountIndex];
    currentAccountIndex = (currentAccountIndex + 1) % state.accounts.length;
    return account;
};

const createExtrinsic = (api: ApiPromise, tx: Transaction): SubmittableExtrinsic<'promise'> => {
    return api.tx[tx.module][tx.method](...tx.params);
};

export const addTransaction = (module: string, method: string, params: any[]): void => {
    const account = getNextAccount();
    if (!account) {
        console.error('No accounts available to submit transaction');
        return;
    }

    const transaction: Transaction = {
        id: account.address + Date.now().toString(),
        submittedBy: account,
        module,
        method,
        params,
        nonce: account.nonce,
        status: TransactionStatus.Pending,
        retryCount: 0,
    };

    updateState(draft => {
        draft.transactionQueue.pending.push(transaction);
        account.nonce += 1; // Increment nonce immediately to prevent race conditions
    });
};

export const processNextTransaction = async (): Promise<void> => {
    const state = getState();
    if (state.transactionQueue.pending.length === 0 || !state.api) return;

    const nextTx = state.transactionQueue.pending[0];
    const account = state.accounts.find(acc => acc.address === nextTx.submittedBy.address);

    if (!account) {
        console.error(`Account not found for address: ${nextTx.submittedBy.address}`);
        updateTransactionStatus(nextTx.id, TransactionStatus.Failed);
        return;
    }

    try {
        const extrinsic = createExtrinsic(state.api, nextTx);

        await new Promise<void>((resolve, reject) => {
            extrinsic.signAndSend(account.keyringPair, { nonce: nextTx.nonce }, ({ status, events }) => {
                if (status.isInBlock || status.isFinalized) {
                    events
                        .filter(({ event }) => state.api!.events.system.ExtrinsicFailed.is(event))
                        .forEach(({ event }) => {
                            console.error(`Transaction failed: ${event.data.toString()}`);
                            reject(new Error(`Transaction failed: ${event.data.toString()}`));
                        });

                    if (status.isFinalized) {
                        console.log(`Transaction finalized at blockHash ${status.asFinalized}`);
                        updateTransactionStatus(nextTx.id, TransactionStatus.Confirmed);
                        resolve();
                    }
                }
            });
        });

        updateTransactionStatus(nextTx.id, TransactionStatus.Submitted);
    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        updateTransactionStatus(nextTx.id, TransactionStatus.Failed);
        // Decrement nonce if transaction failed to submit
        updateState(draft => {
            const account = draft.accounts.find(acc => acc.address === nextTx.submittedBy.address);
            if (account) account.nonce -= 1;
        });
    }
};

export const updateTransactionStatus = (id: string, status: TransactionStatus): void => {
    updateState(draft => {
        const pendingIndex = draft.transactionQueue.pending.findIndex(t => t.id === id);
        if (pendingIndex !== -1) {
            const tx = draft.transactionQueue.pending[pendingIndex];
            tx.status = status;
            if (status === TransactionStatus.Submitted) {
                draft.transactionQueue.processing.push(tx);
                draft.transactionQueue.pending.splice(pendingIndex, 1);
            } else if (status === TransactionStatus.Failed) {
                draft.transactionQueue.pending.splice(pendingIndex, 1);
            }
        } else {
            const processingIndex = draft.transactionQueue.processing.findIndex(t => t.id === id);
            if (processingIndex !== -1) {
                const tx = draft.transactionQueue.processing[processingIndex];
                tx.status = status;
                if (status === TransactionStatus.Confirmed || status === TransactionStatus.Failed) {
                    draft.transactionQueue.processing.splice(processingIndex, 1);
                }
            }
        }
    });
};

export const syncAccountNonce = (address: string, onChainNonce: number): void => {
    updateState(draft => {
        const account = draft.accounts.find(acc => acc.address === address);
        if (account) {
            account.nonce = Math.max(account.nonce, onChainNonce);
        }
    });
};

export const retryFailedTransactions = (): void => {
    const state = getState();
    const failedTransactions = state.transactionQueue.pending.filter(tx => tx.status === TransactionStatus.Failed);

    failedTransactions.forEach(tx => {
        if (tx.retryCount < 5) {
            updateState(draft => {
                const transaction = draft.transactionQueue.pending.find(t => t.id === tx.id);
                if (transaction) {
                    transaction.retryCount += 1;
                    transaction.status = TransactionStatus.Pending;
                    transaction.nonce = getAccountNonce(transaction.submittedBy.address);
                }
            });
        } else {
            console.error(`Transaction ${tx.id} has failed after 5 retries. Removing from queue.`);
            updateTransactionStatus(tx.id, TransactionStatus.Failed);
        }
    });
};

export const getAccountNonce = (address: string): number => {
    const state = getState();
    const account = state.accounts.find(acc => acc.address === address);
    return account ? account.nonce : 0;
};

export const initializeApi = async (nodeUrl: string): Promise<void> => {
    try {
        const provider = new WsProvider(nodeUrl);
        const api = await ApiPromise.create({ provider });
        updateState(draft => {
            draft.api = api;
        });
        console.log('API initialized successfully');
    } catch (error) {
        console.error('Failed to initialize API:', error);
    }
};
