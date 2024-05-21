
var ldap = require('ldapjs')

class LdapPool {
    opts = null
    defaultCallbacks = null
    clients = []

    constructor(opts) {
        this.opts = opts
        this.defaultCallbacks = {
            onend: function () {
                console.error('client end on idle')
            },
            onerror: function (err) {
                console.error('client error on idle: ' + err.message)
            }
        }
    }

    getClient(bindOpts, callbacks) {
        var that = this
        var c
        if (this.clients.length > 0) {
            c = this.clients.pop()
            c._callbacks = callbacks
            if (c._callbacks && c._callbacks.onbind) {
                c._callbacks.onbind.call(c)
            }
        } else {
            c = ldap.createClient(this.opts)
            c.release = function () {
                that.recycle(c)
            }
            c.on('end', function () {
                if (c._callbacks && c._callbacks.onend) {
                    c._callbacks.onend.call(c)
                } else if (c._callbacks && c._callbacks.onerror) {
                    c._callbacks.onerror.call(c, new Error('client unexpected end'))
                }
                that.remove(c)
                c.destroy()
            });
            c.on('error', function (err) {
                if (c._callbacks && c._callbacks.onerror) {
                    c._callbacks.onerror.call(c, err)
                }
                that.remove(c)
                c.destroy()
            });
            c.bind(bindOpts.dn, bindOpts.password, function (err) {
                if (err) {
                    if (c._callbacks && c._callbacks.onerror) {
                        c._callbacks.onerror.call(c, err)
                    }
                    c.destroy()
                    return
                }
                if (c._callbacks && c._callbacks.onbind) {
                    c._callbacks.onbind.call(c)
                }
            })
            c._callbacks = callbacks
        }
        return c
    }

    recycle(client) {
        client._callbacks = this.defaultCallbacks
        this.clients.push(client)
    }

    remove(client) {
        var found = -1
        for (var i = 0; i < this.clients.length; i++) {
            if (this.clients[i] === client) {
                found = i
                break
            }
        }
        if (found >= 0) {
            console.log('client ' + found + ' removed from pool')
            this.clients.splice(found, 1)
        }
    }
}

function createPool(opts) {
    return new LdapPool(opts)
}

exports.createPool = createPool
