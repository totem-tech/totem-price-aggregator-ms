import etherscanAPI from 'etherscan-api'

let esApi

export const getAbi = async (contractAddress, network = 'mainnet') => {
    esApi = esApi || etherscanAPI.init(process.env.EtherscanAPIKey, network, 10000)
    return await esApi.contract.getabi(contractAddress)
}