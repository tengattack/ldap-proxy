CREATE TABLE IF NOT EXISTS lp_mapping_users (
    `id` bigint NOT NULL AUTO_INCREMENT COMMENT 'ID',
    `create_time` bigint NOT NULL DEFAULT '0' COMMENT 'Create Time (UNIX)',
    `modified_time` bigint NOT NULL DEFAULT '0' COMMENT 'Modified Time (UNIX)',
    `delete_time` bigint NOT NULL DEFAULT '0' COMMENT 'Delete Time (UNIX)',
    `account_name` varchar(120) NOT NULL COMMENT 'sAMAccountName',
    `search_base` varchar(255) NOT NULL,
    `mapping_group` varchar(255) NOT NULL,
    `status` tinyint NOT NULL DEFAULT '0',
    PRIMARY KEY (`id`),
    UNIQUE idx_accountname_deletetime (account_name, delete_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
