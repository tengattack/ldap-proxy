
const mysql = require('mysql')

let dbPool = null

function initDbPool(config) {
    dbPool = config ? mysql.createPool(config) : null
}

function queryDb(sql, values) {
    return new Promise(function (resolve, reject) {
        if (!dbPool) {
            reject(new Error('no mysql db configured'))
            return
        }
        dbPool.getConnection(function (err, connection) {
            if (err) {
                reject(err)
                return
            }
            connection.query(sql, values, function (err, results) {
                connection.release()
                if (err) {
                    reject(err)
                    return
                }
                resolve({ results })
            })
        })
    })
}

exports.initDbPool = initDbPool
exports.queryDb = queryDb