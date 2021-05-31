
var assert = require('assert');
var ldap = require('ldapjs');
var fs = require('fs');

var config = JSON.parse(fs.readFileSync('config.json').toString());
var userMaps = {};
var groupMaps = {};
var groupUserMaps = null;
var isDebug = false;

for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '-v') {
        isDebug = true;
    }
}

var server = ldap.createServer();
var client = ldap.createClient({
    url: config.server.url
});

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
    if (ous.length <= 0 || ou_list.length <= 0 || ous.length > ou_list.length) {
        return false;
    }
    for (var i = 0; i < ous.length; i++) {
        if (ous[ous.length - 1 - i] !== ou_list[ou_list.length - 1 - i]) {
            return false;
        }
    }
    return true;
}

server.bind('', function (req, res, next) {
    //var id = req.id.toString();
    var dn = req.dn.toString();
    var pw = req.credentials;
    //console.log('id: ' + id);
    //console.log('bind DN: ' + dn);
    //console.log('bind PW: ' + pw);
    if (!pw) {
        return next(new ldap.InvalidCredentialsError());
    }
    var client2 = ldap.createClient({
        url: config.server.url
    });
    if (req.dn.rdns.length > 0 && 'uid' in req.dn.rdns[0].attrs) {
        dn = req.dn.rdns[0].attrs['uid'].value
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
    if (filter.indexOf('objectclass=organizationalunit') >= 0) {
        is_group = true;
    } else if (filter === '(objectclass=organizationalperson)') {
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
            filter = filter.substr(0, m.index) + ou_filters.join('') + filter.substr(m.index + m[0].length)
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
    var entries = [];

    client.search(base, opts, function (err, search) {
        assert.ifError(err);

        search.on('searchEntry', function (entry) {
            //console.log('entry: ' + JSON.stringify(entry.object, null, 2));
            //console.log(entry.object);
            var obj = {
                messageID: res.messageID,
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
            }
            // it seems useless
            // if (!is_group && (!obj.attributes.objectClass || obj.attributes.objectClass.map((oc) => oc.toString('utf-8')).indexOf('organizationalUnit') < 0)
            //         && !obj.attributes.memberOf) {
            //     obj.attributes.memberOf = get_ou_titles(dn);
            // }

            //entry.messageID = res.messageID;
            if (tmp_usermaps) {
                var uid = obj.attributes.sAMAccountName[0].toString('utf-8')
                tmp_usermaps[uid] = obj;
                var ou_titles = get_ou_titles(dn);
                if (isDebug) {
                    console.log(uid, ou_titles);
                }
                for (var i = 0; i < ou_titles.length; i++) {
                    var ou_title = ou_titles[i]
                    if (!tmp_groupmaps[ou_title]) {
                        tmp_groupmaps[ou_title] = [];
                    }
                    tmp_groupmaps[ou_title].push(obj);
                }
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
                        members.push(users[i].attributes.sAMAccountName[0]);
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
        search.on('error', function (err) {
            console.error('error: ' + err.message);
            next(err);
        });
        search.on('end', function (result) {
            //console.log('status: ' + result.status);
            if (tmp_usermaps) {
                userMaps = tmp_usermaps;
                groupUserMaps = tmp_groupmaps;
                if (isDebug) {
                    console.log('got user entries: ' + Object.keys(tmp_usermaps).length + ' group: ' + Object.keys(tmp_groupmaps).length)
                }
            }
            if (isDebug) {
                console.log('entries: ' + entries.length);
            }
            res.end();
        });
    });
});

server.listen(389, function () {
    console.log('LDAP server listening at %s', server.url);
    client.bind(config.server.bindDN, config.server.bindPW, function (err) {
        if (err) {
            console.error('client bind error: ' + err);
            return;
        }

        console.log('client bind successful');

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

        var opts = {
            filter: '(objectclass=organizationalperson)',
            scope: 'sub',
            attributes: ['uid', 'samaccountname'],
            attrsOnly: true,
        };
        var base = config.searchBase;
        var entries = [];
        var tmp_usermaps = {};
        var tmp_groupmaps = {};

        client.search(base, opts, function (err, search) {
            assert.ifError(err);

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
                // it seems useless
                // if (!is_group && (!obj.attributes.objectClass || obj.attributes.objectClass.map((oc) => oc.toString('utf-8')).indexOf('organizationalUnit'
                //         && !obj.attributes.memberOf) {
                //     obj.attributes.memberOf = get_ou_titles(dn);
                // }
                //entry.messageID = res.messageID;
                if (tmp_usermaps) {
                    var uid = obj.attributes.sAMAccountName[0].toString('utf-8')
                    tmp_usermaps[uid] = obj;
                    var ou_titles = get_ou_titles(dn);
                    if (isDebug) {
                        console.log(uid, ou_titles);
                    }
                    for (var i = 0; i < ou_titles.length; i++) {
                        var ou_title = ou_titles[i]
                        if (!tmp_groupmaps[ou_title]) {
                            tmp_groupmaps[ou_title] = [];
                        }
                        tmp_groupmaps[ou_title].push(obj);
                    }
                }
                entries.push(obj);
            });
            search.on('searchReference', function (referral) {
                //console.log('referral: ' + referral.uris.join());
            });
            search.on('error', function (err) {
                console.error('error: ' + err.message);
                //process.exit(1)
            });
            search.on('end', function (result) {
                //console.log('status: ' + result.status);
                if (tmp_usermaps) {
                    userMaps = tmp_usermaps;
                    groupUserMaps = tmp_groupmaps;
                    if (isDebug) {
                        console.log('got user entries: ' + Object.keys(tmp_usermaps).length + ' group: ' + Object.keys(tmp_groupmaps).length)
                    }
                }
                if (isDebug) {
                    console.log('entries: ' + entries.length);
                }
            });
        });
    });
    client.on('end', function () {
        process.exit();
    });
    client.on('error', function (err) {
        console.error('client error: ' + err)
        process.exit(1);
    });
});
