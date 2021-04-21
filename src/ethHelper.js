import Web3 from 'web3'

let web3

export const getContract = (contractAbi, contractAddress) => {
    // instantiate Web3 instance
    web3 = web3 || new Web3(process.env.EthereumNodeURL)
    // instantiate Web3 smart contract instance for the price feed
    return new web3.eth.Contract(contractAbi, contractAddress)
}

export const getPrice = async (contractAbi, contractAddress) => {
    const priceFeed = getContract(contractAbi, contractAddress)
    let { answer: price, updatedAt } = await priceFeed.methods.latestRoundData().call()
    const decimals = parseInt(await priceFeed.methods.decimals().call()) || 8
    
    return {
        decimals,
        priceUSD: (parseFloat(price) * Math.pow(10, -decimals)).toFixed(decimals),
        updatedAt: new Date(updatedAt * 1000).toISOString(),
    }
}