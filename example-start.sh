#!/bin/sh
# init submodules if not already done
#git submodule init
# update submodules recursively
#git submodule update --recursive --remote

# Start application
CouchDB_URL="string: CouchDB connection URL" \
STORAGE_PATH="string: (optional) path to JSON storage directory. Default: `./data`" \
EthereumNodeURL="string: Ethereum node URL. Required to read price feed smart contracts." \
EtherscanAPIKey="string: (optional) Etherscan API key. Only required if there is missing smart contract ABI(s)." \
cycleDurationMin="int: (optional) delay in number of minutes between execution. Leave empty or use 0 to execute only once." \
yarn run dev
