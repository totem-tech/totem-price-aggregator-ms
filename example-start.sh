#!/bin/sh
# init submodules if not already done
#git submodule init
# update submodules recursively
#git submodule update --recursive --remote

# Start application
CMC_URL="string: CMC API base URL. For sandbox use: https://sandbox-api.coinmarketcap.com/v1" \
CMC_APIKey="string: CMC API key" \
CouchDB_URL="string: CouchDB connection URL" \
STORAGE_PATH="string: (optional) path to JSON storage directory. Default: `./data`" \
EthereumNodeURL="string: Ethereum node URL. Required to read price feed smart contracts." \
EtherscanAPIKey="string: (optional) Etherscan API key. Only required if there is missing smart contract ABI(s)." \
cycleDurationMin="int: (optional) delay in number of minutes between execution. Leave empty or use 0 to execute only once." \
DISCORD_WEBHOOK_USERNAME="string: name to be displayed as sender" \
DISCORD_WEBHOOK_URL="string: URL of the webhook" \
DISCORD_WEBHOOK_AVATAR_URL="string: URL of the sender user avater" \
yarn run dev
