
var assert = require('assert');
var ldap = require('ldapjs');
var fs = require('fs');
var mysql = require('mysql');

var USER_STATUS_DEFAULT = 0
var USER_STATUS_NOT_FOUND = -1

var config = JSON.parse(fs.readFileSync('config.json').toString());
var groupMaps = {};
var groupUserMaps = null;
var mappingUsers = [];
var mappingUserDNs = {};
var mappingGroupMaps = {};
var isDebug = false;

for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '-v') {
        isDebug = true;
    }
}

var dbPool = mysql.createPool(config.mysql);

var server = ldap.createServer();
var client = ldap.createClient({
    url: config.server.url
});
var clientCallbacks = {}

function get_ou_list(dn) {
    var ous = [];
    for (var i = 0; i < dn.rdns.length; i++) {
        if ('ou' in dn.rdns[i].attrs) {
            ous.push(dn.rdns[i].attrs['ou'].value);
        }
    }
    // remove base ou
    ous.splice(ous.length - 1, 1);
    return ous;
}

function get_ou_titles(dn) {
    // join ou with levels
    var ou_titles = [];
    var ous = get_ou_list(dn);
    for (var i = 0; i < ous.length; i++) {
        ou_titles.push(ous.slice(i).reverse().join('-'));
    }
    return ou_titles;
}

function get_ou_title(dn) {
    var ous = get_ou_list(dn);
    return ous.reverse().join('-');
}

function is_belong_to(ou_list, dn) {
    var ous = get_ou_list(dn);
    // allow sub ou ['helpdesk', 'it'] belong to root ou []
    if (ous.length < 0 || ou_list.length <= 0 || ous.length > ou_list.length) {
        return false;
    }
    for (var i = 0; i < ous.length; i++) {
        if (ous[ous.length - 1 - i] !== ou_list[ou_list.length - 1 - i]) {
            return false;
        }
    }
    return true;
}

function is_same_group(ou_list, dn) {
    var ous = get_ou_list(dn);
    if (ous.length <= 0 || ou_list.length <= 0 || ous.length !== ou_list.length) {
        return false;
    }
    for (var i = 0; i < ous.length; i++) {
        if (ous[ous.length - 1 - i] !== ou_list[ou_list.length - 1 - i]) {
            return false;
        }
    }
    return true;
}

function add_to_group_maps(obj, dn, groupmaps) {
    var ou_titles = get_ou_titles(dn);
    if (isDebug) {
        var uid = obj.attributes.sAMAccountName[0].toString('utf-8')
        console.log(uid, ou_titles);
    }
    for (var i = 0; i < ou_titles.length; i++) {
        var ou_title = ou_titles[i]
        if (!groupmaps[ou_title]) {
            groupmaps[ou_title] = [];
        }
        groupmaps[ou_title].push(obj);
    }
}

function merge_group_maps(m1, m2) {
    for (var k in m2) {
        if (!m1[k]) {
            m1[k] = []
        }
        m1[k] = Array.prototype.concat.apply(m1[k], m2[k])
    }
    join_level1_group(groupUserMaps)
}

function join_level1_group(m) {
    let firstGroupTitle = null
    for (const title in m) {
        if (title.indexOf('-') >= 0 ) {
            continue
        }
        if (!firstGroupTitle) {
            firstGroupTitle = title
        } else {
            m[firstGroupTitle] = Array.prototype.concat.apply(m[firstGroupTitle], m[title])
        }
    }
}

function get_search_base_list(base) {
    var dn = ldap.parseDN(base);
    var is_base_ou = dn.rdns.length > 0 && 'ou' in dn.rdns[0].attrs;
    if (!is_base_ou) {
        return [base];
    }
    var searchBases = [];
    var ou_list = get_ou_list(dn);
    for (var i = 0; i < config.searchBase.length; i++) {
        var baseDN = ldap.parseDN(config.searchBase[i]);
        if (is_belong_to(ou_list, baseDN)) {
            searchBases.push(base);
            break;
        }
        var search_ou_list = get_ou_list(baseDN);
        if (search_ou_list.length > ou_list.length) {
            var ok = true;
            for (var j = 0; j < ou_list.length; j++) {
                if (search_ou_list[search_ou_list.length - 1 - j] !== ou_list[ou_list.length - 1 - j]) {
                    ok = false;
                }
            }
            if (ok) {
                searchBases.push(baseDN.toString())
            }
        }
    }
    return searchBases;
}

function baseSearchInitAll(callback) {

    // TODO: bootstrap
    // base: ou=it, ou=domian.local, dc=domain, dc=local
    // filter: (objectclass=organizationalperson)
    // scope: sub
    // attributes: dn,samaccountname,uid,mail,pwdchangedtime,pwdreset,pwdpolicysubentry,pwdaccountlockedtime,shadowlastchange,shadowmin,shadowmax,shadowwarning$
    //   shadowinactive,shadowexpire,shadowflag,sambapwdlastset
    //
    // base: ou=it, ou=domain.local, dc=domain, dc=local
    // filter: (objectclass=organizationalunit)
    // scope: sub
    // attributes: dn,cn,cn,description

    var done = false

    var initDone = function () {
        done = true
        clientCallbacks.onend = null
        clientCallbacks.onerror = null
        callback()
    }
    clientCallbacks.onend = function () {
        var err = new Error('client unexpected end')
        if (!done) {
            callback(err)
            return
        }
        assert.ifError(err)
    }
    clientCallbacks.onerror = function (err) {
        if (!done) {
            callback(err)
            return
        }
        assert.ifError(err)
    }

    var opts = {
        filter: '(objectclass=organizationalperson)',
        scope: 'sub',
        attributes: ['uid', 'samaccountname'],
        attrsOnly: true,
    };
    var entries = [];
    var tmp_usermaps = {};
    var tmp_groupmaps = {};

    var searchCount = 0;

    var searchNext = function (i) {
        var base = config.searchBase[i];
    client.search(base, opts, function (err, search) {
        if (err) {
            if (!done) {
                callback(err)
                return
            }
            assert.ifError(err)
        }

        search.on('searchEntry', function (entry) {
            //console.log('entry: ' + JSON.stringify(entry.object, null, 2));
            //console.log(entry.object);
            var obj = {
                //messageID: res.messageID,
                dn: entry.dn.toString(),
                attributes: {},
            };
            var dn = ldap.parseDN(obj.dn);
            /*if (search_ous && !is_belong_to(search_ous, dn)) {
                if (isDebug) {
                    console.log('!isbelongto', obj.dn, search_ous)
                }
                // ignore
                return;
            }*/
            entry.attributes.forEach(function (a) {
                obj.attributes[a.type] = a._vals;
                //obj.attributes.push(a.json || a);
            });
            if (!obj.attributes.uid && obj.attributes.sAMAccountName) {
                obj.attributes.uid = obj.attributes.sAMAccountName;
            }
            var memberOf = obj.attributes.memberOf || [];
            obj.attributes.memberOf = Array.prototype.concat.apply(memberOf, get_ou_titles(dn));

            //entry.messageID = res.messageID;
            if (tmp_usermaps) {
                var uid = obj.attributes.sAMAccountName[0].toString('utf-8')
                tmp_usermaps[uid] = obj;
                add_to_group_maps(obj, dn, tmp_groupmaps);
            }
            entries.push(obj);
        });
        search.on('searchReference', function (referral) {
            //console.log('referral: ' + referral.uris.join());
        });
        search.on('error', function (err) {
            console.error('base search error: ' + err.message);
            //process.exit(1)
        });
        search.on('end', function (result) {
            //console.log('status: ' + result.status);
            searchCount++;
            if (searchCount < config.searchBase.length) {
                searchNext(i + 1);
            } else {
                if (tmp_usermaps) {
                    groupUserMaps = tmp_groupmaps;
                    merge_group_maps(groupUserMaps, mappingGroupMaps)
                    if (isDebug) {
                        console.log('got user entries: ' + Object.keys(tmp_usermaps).length + ' group: ' + Object.keys(tmp_groupmaps).length)
                    }
                }
                console.log('all user entries: ' + entries.length + ', mapping: ' + mappingUsers.length);
                initDone()
            }
        });
    });

    };

    searchNext(0);
}

server.bind('', function (req, res, next) {
    //var id = req.id.toString();
    var dn = req.dn.toString();
    var pw = req.credentials;
    if (isDebug) {
        //console.log('id: ' + id);
        console.log('bind DN: ' + dn);
        //console.log('bind PW: ' + pw);
    }
    if (!pw) {
        return next(new ldap.InvalidCredentialsError());
    }
    var client2 = ldap.createClient({
        url: config.server.url
    });
    var is_uid = false;
    if (req.dn.rdns.length > 0 && 'uid' in req.dn.rdns[0].attrs) {
        dn = req.dn.rdns[0].attrs['uid'].value
        is_uid = true;
    }
    if (!is_uid) {
        for (var i = 0; i < mappingUsers.length; i++) {
            var obj = mappingUsers[i]
            if (obj.dn === dn) {
                dn = obj.attributes.uid[0].toString('utf-8')
                is_uid = true;
                break;
            }
        }
    }
    if (is_uid) {
        if (mappingUserDNs[dn]) {
            dn = mappingUserDNs[dn];
        }
    }
    client2.bind(dn, pw, function (err) {
        client2.unbind(function (err) {});
        if (err) {
            console.log('client2 bind error: ' + err);
            next(err);
            return;
        }
        res.end();
    });
    client2.on('error', function (err) {
        console.log('client2 bind error: ' + err);
        next(err);
    })
});

server.unbind((req, res, next) => {
    res.end();
});

server.search('', function (req, res, next) {

    // if ldap bind succeed, bindDN will be 'cn=anonymous'
    if (req.connection.ldap.bindDN.rdns.length <= 0) {
        return next(new ldap.InsufficientAccessRightsError());
    }

    //console.log(req);
    //console.log('type: ' + req.type);
    //console.log('json: ' + JSON.stringify(req.json, null, 2));

    var id = req.id.toString();
    var base = req.dn.toString();
    var filter = req.filter.toString();
    var scope = req.scope.toString();

    var is_group = false
    var search_ous = null
    var tmp_usermaps = null
    var tmp_groupmaps = null
    var is_base_ou = req.dn.rdns.length > 0 && 'ou' in req.dn.rdns[0].attrs

    if (filter.indexOf('(objectclass=posixaccount)') >= 0) {
        res.end();
        return;
    } else if (filter.indexOf('(objectclass=organizationalunit)') >= 0 || (is_base_ou && scope === 'base')) {
        is_group = true;
    } else if (scope === 'sub' && filter === '(objectclass=organizationalperson)') {
        tmp_usermaps = {}
        tmp_groupmaps = {}
    }

    //console.log('id: ' + id);
    if (isDebug) {
        console.log('base: ' + base);
        console.log('filter: ' + filter);
        console.log('scope: ' + scope);
        console.log('attributes: ' + req.attributes.join());
    }
    if (scope === 'base' || scope === 'one' || scope === 'sub') {
        for (var i = 0; i < mappingUsers.length; i++) {
            var obj = mappingUsers[i]
            if (obj.dn === base) {
                if (scope === 'base' || scope === 'sub') {
                    if (isDebug) {
                        console.log('direct send:', obj.dn)
                    }
                    res.send(obj);
                    res.end();
                } else {
                    res.end();
                }
                return;
            }
        }
    }
    if (is_group) {
        var filter0 = filter
        // console.log('attributes: ' + req.attributes);
        var m = filter.match(/\(member=(cn=.*?)\)/)
        // (&(objectclass=organizationalunit)(|(member=pengzhuoteng)(member=cn=john,ou=helpdesk,ou=it,ou=domain.local,dc=domain,dc=local)))
        // map to: ...(ou=helpdesk)(ou=it)
        if (m) {
            var dn = ldap.parseDN(m[1])
            search_ous = get_ou_list(dn)
            var ou_filters = search_ous.map(function (value) {
                return '(ou=' + value + ')';
            });
            // convert to (&(objectclass=organizationalunit)(!(ou=helpdesk)(ou=it)))
            filter = filter.substr(0, m.index) + '(|' + ou_filters.join('') + ')' + filter.substr(m.index + m[0].length)
        }
        if (filter.indexOf('(cn=') >= 0) {
            // filter: (&(objectclass=organizationalunit)(cn=helpdesk-it))
            m = filter.match(/\(cn=(.*?)\)/)
            if (m) {
                var ou_title = m[1];
                if (ou_title in groupMaps) {
                    if (isDebug) {
                        console.log('found', ou_title, groupMaps[ou_title].attributes.member.map(m => m.toString('utf-8')))
                    }
                    res.send(groupMaps[ou_title]);
                }
            }
            res.end();
            return;
        }
        if (isDebug && filter !== filter0) {
            console.log('new filter:', filter)
        }
    }
    var opts = {
        filter: filter.replace('uid=', 'sAMAccountName='),
        scope: scope,
        attributes: req.attributes.slice(),
        attrsOnly: req.typesOnly,
        sizeLimit: req.sizeLimit,
        timeLimit: req.timeLimit,
    };
    if (opts.attributes.indexOf('uid') >= 0 && opts.attributes.indexOf('samaccountname') < 0) {
        // add samaccountname for uid filter
        opts.attributes.push('samaccountname')
    }
    if (is_group) {
        opts.attributes.push('ou');
    }

    var is_uid_filter = false

    var entries = [];
    var mapping_entries = 0;

    var checkpf = function (pf) {
        if (pf.attribute.toLowerCase() === 'samaccountname') {
            is_uid_filter = true
            var uid = pf.raw.toString('utf-8')
            for (var i = 0; i < mappingUsers.length; i++) {
                var obj = mappingUsers[i]
                if (obj.attributes.uid[0].toString('utf-8') === uid) {
                    if (isDebug) {
                        console.log('direct send:', obj.dn)
                    }
                    mapping_entries++;
                    entries.push(obj);
                    res.send(obj);
                    return true;
                }
            }
        }
        return false;
    }

    // TODO: support more complex filter
    var pf = ldap.parseFilter(opts.filter)
    if (pf instanceof ldap.AndFilter) {
        for (var i = 0; i < pf.filters.length; i++) {
            var subpf = pf.filters[i]
            if (subpf instanceof ldap.EqualityFilter) {
                if (checkpf(subpf)) {
                    res.end();
                    return;
                }
            }
        }
    } else if (pf instanceof ldap.OrFilter) {
        for (var i = 0; i < pf.filters.length; i++) {
            var subpf = pf.filters[i]
            if (subpf instanceof ldap.EqualityFilter) {
                checkpf(subpf)
            }
        }
    } else if (pf instanceof ldap.EqualityFilter) {
        if (checkpf(pf)) {
            res.end();
            return;
        }
    }


    var searchCount = 0;
    var searchBases = get_search_base_list(base);
    if (searchBases.length <= 0) {
        res.end();
        return;
    }
    var searchNext = function (i) {
        var base = searchBases[i];
    client.search(base, opts, function (err, search) {
        if (err) {
            next(err);
            return;
        }

        search.on('searchEntry', function (entry) {
            //console.log('entry: ' + JSON.stringify(entry.object, null, 2));
            //console.log(entry.object);
            var obj = {
                //messageID: res.messageID,
                dn: entry.dn.toString(),
                attributes: {},
            };
            var dn = ldap.parseDN(obj.dn);
            if (search_ous && !is_belong_to(search_ous, dn)) {
                if (isDebug) {
                    console.log('!isbelongto', obj.dn, search_ous)
                }
                // ignore
                return;
            }
            entry.attributes.forEach(function (a) {
                obj.attributes[a.type] = a._vals;
                //obj.attributes.push(a.json || a);
            });
            if (!obj.attributes.uid && obj.attributes.sAMAccountName) {
                obj.attributes.uid = obj.attributes.sAMAccountName;
            }
            if (obj.attributes.ou) {
                var ou_title = get_ou_title(dn);
                // remap to ou full name
                obj.attributes.cn = obj.attributes.ou = [ou_title];
                if (!obj.attributes.description) {
                    obj.attributes.description = obj.attributes.ou
                }
            } else {
                var memberOf = obj.attributes.memberOf || [];
                obj.attributes.memberOf = Array.prototype.concat.apply(memberOf, get_ou_titles(dn));
            }

            //entry.messageID = res.messageID;
            if (tmp_usermaps) {
                // FIXME: sAMAccountName is null
                var uid = obj.attributes.sAMAccountName[0].toString('utf-8')
                tmp_usermaps[uid] = obj;
                add_to_group_maps(obj, dn, tmp_groupmaps);
            }
            if (is_group && groupUserMaps) {
                var ou_title = get_ou_title(dn);
                // base: ou=it, ou=domain.local, dc=domain, dc=local
                // filter: (&(objectclass=organizationalunit)(cn=helpdesk))
                // scope: sub
                // attributes: member,objectguid,cn
                var members = [];
                if (ou_title in groupUserMaps) {
                    var users = groupUserMaps[ou_title];
                    for (var i = 0; i < users.length; i++) {
                        members.push(users[i].dn);
                    }
                }
                if (members.length > 0) {
                    obj.attributes.member = members;
                }
                groupMaps[ou_title] = obj;
                if (isDebug) {
                    console.log(ou_title, members.map(m => m.toString('utf-8')))
                }
            }
            entries.push(obj);
            res.send(obj);
        });
        search.on('searchReference', function (referral) {
            //console.log('referral: ' + referral.uris.join());
        });
        var onNext = function () {
            searchCount++;
            if (searchCount < searchBases.length) {
                searchNext(i + 1);
            } else {
            if (!is_uid_filter) {
                if (!is_group && is_base_ou && (scope === 'sub' || scope === 'one')) {
                    if (mappingUsers && mappingUsers.length > 0) {
                        for (var j = 0; j < mappingUsers.length; j++) {
                            var obj = mappingUsers[j]
                            var ou_list = get_ou_list(ldap.parseDN(obj.dn))
                            if (scope === 'sub') {
                                if (is_belong_to(ou_list, req.dn)) {
                                    mapping_entries++
                                    entries.push(obj)
                                    res.send(obj)
                                }
                            } else {
                                if (is_same_group(ou_list, req.dn)) {
                                    mapping_entries++
                                    entries.push(obj)
                                    res.send(obj)
                                }
                            }
                        }
                    }
                }
                if (tmp_usermaps) {
                    groupUserMaps = tmp_groupmaps;
                    merge_group_maps(groupUserMaps, mappingGroupMaps)
                    if (isDebug) {
                        console.log('got user entries: ' + Object.keys(tmp_usermaps).length + ' group: ' + Object.keys(tmp_groupmaps).length)
                    }
                }
            }
            if (isDebug) {
                console.log('entries: ' + entries.length + ', mapping: ' + mapping_entries);
            }
            res.end();
            }
        }
        search.on('error', function (err) {
            console.error('search error: ' + err.message);
            onNext();
        });
        search.on('end', function (result) {
            onNext();
        });
    });
    };
    searchNext(0);
});

function startServer() {
    clientCallbacks.onend = function () {
        console.error('client unexpected end')
        process.exit(1)
    }
    clientCallbacks.onerror = function (err) {
        console.error('client error: ' + err)
        process.exit(1)
    }

    server.listen(config.port || 389, function () {
        console.log('LDAP server listening at %s', server.url);
    });
}

function startupInitWithMappingUsers(configUsers, isUid, onUserStatus, callback) {
    var done = false

    var initDone = function () {
        done = true
        clientCallbacks.onend = null
        clientCallbacks.onerror = null
        callback()
    }
    clientCallbacks.onend = function () {
        var err = new Error('client unexpected end')
        if (!done) {
            callback(err)
            return
        }
        assert.ifError(err)
    }
    clientCallbacks.onerror = function (err) {
        if (!done) {
            callback(err)
            return
        }
        assert.ifError(err)
    }

    client.bind(config.server.bindDN, config.server.bindPW, function (err) {
        if (err) {
            if (!done) {
                callback(err);
                return;
            }
            assert.ifError(err)
        }

        console.log('client bind successful');

        if (configUsers && configUsers.length > 0) {
            var counter = 0
            configUsers.forEach(function (user) {
                var opts = {
                    filter: '(&(objectclass=organizationalperson)',
                    scope: 'sub',
                };
                if (isUid) {
                    opts.filter += '(uid=' + user.account_name + '))';
                } else {
                    opts.filter += '(sAMAccountName=' + user.account_name + '))';
                }

                var tmp_groupmaps = []
                var tmp_mapping_users = []
                var tmp_mapping_user_dns = {}
                var found = false

                client.search(user.search_base, opts, function (err, search) {
                    if (err) {
                        if (!done) {
                            callback(err);
                            return;
                        }
                        assert.ifError(err)
                    }

                    search.on('searchEntry', function (entry) {
                        var obj = {
                            dn: entry.dn.toString(),
                            attributes: {},
                        };
                        var dn = ldap.parseDN(obj.dn);
                        if (!('cn' in dn.rdns[0].attrs)) {
                            // only map person
                            return;
                        }
                        var mapDN = dn.rdns[0].attrs['cn'].name + '=' + dn.rdns[0].attrs['cn'].value + ', ' + user.mapping_group
                        dn = ldap.parseDN(mapDN)

                        entry.attributes.forEach(function (a) {
                            obj.attributes[a.type] = a._vals;
                            //obj.attributes.push(a.json || a);
                        });
                        if (!obj.attributes.uid && obj.attributes.sAMAccountName) {
                            obj.attributes.uid = obj.attributes.sAMAccountName;
                        }
                        tmp_mapping_user_dns[obj.attributes.sAMAccountName[0].toString('utf-8')] = obj.dn

                        obj.attributes.department = [get_ou_title(dn)];
                        obj.dn = dn.toString()
                        if (obj.attributes.distinguishedName) {
                            obj.attributes.distinguishedName = [obj.dn];
                        }
                        var memberOf = obj.attributes.memberOf || [];
                        obj.attributes.memberOf = Array.prototype.concat.apply(memberOf, get_ou_titles(dn));

                        add_to_group_maps(obj, dn, tmp_groupmaps);

                        tmp_mapping_users.push(obj);
                        found = true
                    });
                    search.on('searchReference', function (referral) {
                        //console.log('referral: ' + referral.uris.join());
                    });
                    search.on('error', function (err) {
                        console.error('mapping search error: ' + err.message);
                        //process.exit(1)
                    });
                    search.on('end', function (result) {
                        if (!found) {
                            onUserStatus(user, USER_STATUS_NOT_FOUND)
                        }
                        if (counter === 0) {
                            mappingUsers = tmp_mapping_users;
                            mappingGroupMaps = tmp_groupmaps;
                            mappingUserDNs = tmp_mapping_user_dns;
                        } else {
                            mappingUsers = Array.prototype.concat.apply(mappingUsers, tmp_mapping_users)
                            merge_group_maps(mappingGroupMaps, tmp_groupmaps)
                            mappingUserDNs = Object.assign(mappingUserDNs, tmp_mapping_user_dns)
                        }
                        counter++
                        if (counter >= configUsers.length) {
                            initDone()
                        }
                    });
                })
            })
        } else {
            initDone()
        }
    });
}

function main() {
    client.on('end', function () {
        if (clientCallbacks.onend) {
            clientCallbacks.onend()
        }
    });
    client.on('error', function (err) {
        if (clientCallbacks.onerror) {
            clientCallbacks.onerror(err)
        }
    });

    dbPool.getConnection(function (err, connection) {
        if (err) {
            console.error('db connect error: ' + err)
            process.exit(1)
        }

        connection.query('SELECT id, account_name, search_base, mapping_group, status FROM lp_mapping_users WHERE delete_time = 0 AND status = ?', [USER_STATUS_DEFAULT], function (err, results) {
            connection.release()
            if (err) {
                console.error('db query error: ' + err)
                process.exit(1)
            }

            console.log('mapping users count: ' + results.length)

            var notFoundUserIds = []

            startupInitWithMappingUsers(results, false, function (user, status) {
                if (status === USER_STATUS_NOT_FOUND) {
                    // user not found
                    console.log('user ' + user.account_name + ' not found!')
                    notFoundUserIds.push(user.id)
                }
            }, function (err) {
                if (err) {
                    console.error('ldap client startup init error: ' + err)
                    process.exit(1)
                }

                if (notFoundUserIds.length > 0) {
                    // async
                    dbPool.getConnection(function(err, connection) {
                        if (err) {
                            console.error('db connect error: ' + err)
                            return
                        }
                        connection.query('UPDATE lp_mapping_users SET status = ?, modified_time = ? WHERE id IN (?)',
                            [USER_STATUS_NOT_FOUND, Math.floor(Date.now() / 1000), notFoundUserIds],
                            function (err) {
                                connection.release()
                                if (err) {
                                    console.error('update not found users status error: ' + err)
                                    // PASS
                                }
                            })
                    })
                }

                baseSearchInitAll(function (err) {
                    if (err) {
                        console.error('base search error: ' + err)
                        process.exit(1)
                    }

                    startServer()
                })
            })
        })
    })
}

main()
