import Web3 from 'web3'

let web3
const EthereumNodeURL = process.env.EthereumNodeURL

export const getContract = (contractAbi, contractAddress) => {
    // instantiate Web3 instance
    web3 = web3 || new Web3(EthereumNodeURL)
    // instantiate Web3 smart contract instance for the price feed
    return new web3.eth.Contract(contractAbi, contractAddress)
}

export const getPrice = async (contractAbi, contractAddress) => {
    const priceFeed = getContract(contractAbi, contractAddress)
    let { answer: price, updatedAt } = await priceFeed.methods.latestRoundData().call()
    const decimals = parseInt(await priceFeed.methods.decimals().call()) || 0

    return {
        decimals,
        priceUSD: (parseFloat(price) * Math.pow(10, -decimals))
            .toFixed(decimals + 2),
        updatedAt: new Date(updatedAt * 1000).toISOString(),
    }
}

export const getPriceAlt = async (contractAbi, contractAddress, ticker) => {
    const priceFeed = getContract(contractAbi, contractAddress)

    const price = await priceFeed.methods.latestAnswer().call()
    const ts = await priceFeed.methods.latestTimestamp().call()
    const decimals = parseInt(await priceFeed.methods.decimals().call()) || 0
    const priceUSD = (parseFloat(price) * Math.pow(10, -decimals))
        .toFixed(decimals + 2)
    const updatedAt = new Date(ts * 1000)
        .toISOString()
    return {
        decimals,
        priceUSD,
        updatedAt,
    }
}