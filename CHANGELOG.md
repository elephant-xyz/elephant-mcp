# [1.8.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.7.0...v1.8.0) (2026-08-27)


### Bug Fixes

* avoid dataset-info parquet timeouts ([#48](https://github.com/elephant-xyz/elephant-mcp/issues/48)) ([9688e88](https://github.com/elephant-xyz/elephant-mcp/commit/9688e887266e1e0f28d0aeb996333991e8d22d3e))
* persist on-demand permit harvests to Neon (onDemand flag) ([#30](https://github.com/elephant-xyz/elephant-mcp/issues/30)) ([f306c79](https://github.com/elephant-xyz/elephant-mcp/commit/f306c791bc0f3c5e4561176a3201b2836be6ca42))
* **query:** set DuckDB home_directory before INSTALL httpfs on serverless ([#28](https://github.com/elephant-xyz/elephant-mcp/issues/28)) ([275adc8](https://github.com/elephant-xyz/elephant-mcp/commit/275adc826ab49cfc6b5470c8b8d4154b7022ff11))


### Features

* add bounded Overture co-location discovery ([#45](https://github.com/elephant-xyz/elephant-mcp/issues/45)) ([5c085ca](https://github.com/elephant-xyz/elephant-mcp/commit/5c085ca2520f9b776eae29d8b88e48448129a934))
* **getOracleDatasetInfo:** per-source coverage datasets[] ([#31](https://github.com/elephant-xyz/elephant-mcp/issues/31)) ([4e88d75](https://github.com/elephant-xyz/elephant-mcp/commit/4e88d7597235e8c0b08a79499acbff36db1c32bf))
* publish Rock Island with additive configuration ([#43](https://github.com/elephant-xyz/elephant-mcp/issues/43)) ([0aca2c4](https://github.com/elephant-xyz/elephant-mcp/commit/0aca2c467ac731e0a35aa999b8c0a184e62f042e))

# [1.7.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.6.0...v1.7.0) (2026-06-26)


### Bug Fixes

* **ci:** npm OIDC trusted publishing (no NPM_TOKEN) ([#24](https://github.com/elephant-xyz/elephant-mcp/issues/24)) ([3e136eb](https://github.com/elephant-xyz/elephant-mcp/commit/3e136eb30082274d80180f09e980d900932c08d3))
* **ci:** unblock npm release for Oracle MCP tools ([#22](https://github.com/elephant-xyz/elephant-mcp/issues/22)) ([b112fb6](https://github.com/elephant-xyz/elephant-mcp/commit/b112fb69c768b8ab69d063c62b6d8670c253838f))
* **ci:** use checkout token input for RELEASE_TOKEN ([#23](https://github.com/elephant-xyz/elephant-mcp/issues/23)) ([06a5419](https://github.com/elephant-xyz/elephant-mcp/commit/06a5419097d3141539fd7b1f3faa24f38ed8833c))


### Features

* **oracle2:** MCP access to open Oracle data (per-property manifest) ([#19](https://github.com/elephant-xyz/elephant-mcp/issues/19)) ([c662e2e](https://github.com/elephant-xyz/elephant-mcp/commit/c662e2ef22a9e8852510fb4723d746b888e7d73b))
* **oracle:** geo exposure tools (findPropertiesInArea, sumPropertyValueInArea) ([a84c551](https://github.com/elephant-xyz/elephant-mcp/commit/a84c551eebaaef9e42c57c524b46b848ec83b1b2))

# [1.6.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.5.0...v1.6.0) (2025-12-18)


### Features

* trigger release ([04491aa](https://github.com/elephant-xyz/elephant-mcp/commit/04491aa66e242f67471fac8409a541e8c0cb9a88))

# [1.5.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.4.0...v1.5.0) (2025-12-18)


### Features

* add support for AWS Bedrock as an embedding provider ([#18](https://github.com/elephant-xyz/elephant-mcp/issues/18)) ([8cb3579](https://github.com/elephant-xyz/elephant-mcp/commit/8cb3579afe39ed45f33234a614dc403c51e6c7ba))

# [1.4.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.3.0...v1.4.0) (2025-11-20)


### Bug Fixes

* dumo zod-to-json-schema ([#14](https://github.com/elephant-xyz/elephant-mcp/issues/14)) ([abfcb52](https://github.com/elephant-xyz/elephant-mcp/commit/abfcb52fb15838d1caafa64c4bf43c698439e357))
* fix zod version ([bfb603d](https://github.com/elephant-xyz/elephant-mcp/commit/bfb603d8adb948b69328c364134dc55790331db1))
* override zod version ([#15](https://github.com/elephant-xyz/elephant-mcp/issues/15)) ([87b58b2](https://github.com/elephant-xyz/elephant-mcp/commit/87b58b2704fe4706366587a761d55db3f888c1e7))
* trigger release ([0c3beb6](https://github.com/elephant-xyz/elephant-mcp/commit/0c3beb6a3afa732e47f291487d952bbbcdd6e902))


### Features

* bump version ([9f23739](https://github.com/elephant-xyz/elephant-mcp/commit/9f23739a13a594c2d53f3b4556c3cc99ccaf673b))

## [1.3.1](https://github.com/elephant-xyz/elephant-mcp/compare/v1.3.0...v1.3.1) (2025-11-20)


### Bug Fixes

* dumo zod-to-json-schema ([#14](https://github.com/elephant-xyz/elephant-mcp/issues/14)) ([abfcb52](https://github.com/elephant-xyz/elephant-mcp/commit/abfcb52fb15838d1caafa64c4bf43c698439e357))
* fix zod version ([bfb603d](https://github.com/elephant-xyz/elephant-mcp/commit/bfb603d8adb948b69328c364134dc55790331db1))
* override zod version ([#15](https://github.com/elephant-xyz/elephant-mcp/issues/15)) ([87b58b2](https://github.com/elephant-xyz/elephant-mcp/commit/87b58b2704fe4706366587a761d55db3f888c1e7))
* trigger release ([0c3beb6](https://github.com/elephant-xyz/elephant-mcp/commit/0c3beb6a3afa732e47f291487d952bbbcdd6e902))

## [1.3.1](https://github.com/elephant-xyz/elephant-mcp/compare/v1.3.0...v1.3.1) (2025-11-20)


### Bug Fixes

* dumo zod-to-json-schema ([#14](https://github.com/elephant-xyz/elephant-mcp/issues/14)) ([abfcb52](https://github.com/elephant-xyz/elephant-mcp/commit/abfcb52fb15838d1caafa64c4bf43c698439e357))
* fix zod version ([bfb603d](https://github.com/elephant-xyz/elephant-mcp/commit/bfb603d8adb948b69328c364134dc55790331db1))
* override zod version ([#15](https://github.com/elephant-xyz/elephant-mcp/issues/15)) ([87b58b2](https://github.com/elephant-xyz/elephant-mcp/commit/87b58b2704fe4706366587a761d55db3f888c1e7))

## [1.3.1](https://github.com/elephant-xyz/elephant-mcp/compare/v1.3.0...v1.3.1) (2025-11-19)


### Bug Fixes

* dumo zod-to-json-schema ([#14](https://github.com/elephant-xyz/elephant-mcp/issues/14)) ([abfcb52](https://github.com/elephant-xyz/elephant-mcp/commit/abfcb52fb15838d1caafa64c4bf43c698439e357))
* fix zod version ([bfb603d](https://github.com/elephant-xyz/elephant-mcp/commit/bfb603d8adb948b69328c364134dc55790331db1))

# [1.3.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.2.1...v1.3.0) (2025-11-12)


### Features

* **schema:** filtering deprecated schema  ([#13](https://github.com/elephant-xyz/elephant-mcp/issues/13)) ([1dbf968](https://github.com/elephant-xyz/elephant-mcp/commit/1dbf968e1e80c1c0349285955fa73cb4dbd1d4b8))

## [1.2.1](https://github.com/elephant-xyz/elephant-mcp/compare/v1.2.0...v1.2.1) (2025-10-31)


### Bug Fixes

* **ipfs:** swap IPFS fetch order for getJsonByCid ([#12](https://github.com/elephant-xyz/elephant-mcp/issues/12)) ([f3216af](https://github.com/elephant-xyz/elephant-mcp/commit/f3216afa66171f06f14ef6d13b77f8078c0b44c2))

# [1.2.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.1.0...v1.2.0) (2025-10-22)


### Features

* code samples ([#9](https://github.com/elephant-xyz/elephant-mcp/issues/9)) ([6ef0730](https://github.com/elephant-xyz/elephant-mcp/commit/6ef073024869b5ac7c6fce96090c1535ac68c8d0))

# [1.1.0](https://github.com/elephant-xyz/elephant-mcp/compare/v1.0.1...v1.1.0) (2025-10-17)


### Features

* **classes:** add enum to property_type schema ([#7](https://github.com/elephant-xyz/elephant-mcp/issues/7)) ([cbfcfe5](https://github.com/elephant-xyz/elephant-mcp/commit/cbfcfe564a9150baac90de780a38e6d57f6f2df4))

## [1.0.1](https://github.com/elephant-xyz/elephant-mcp/compare/v1.0.0...v1.0.1) (2025-10-17)

# 1.0.0 (2025-10-16)


### Features

* provide esential tools ([#6](https://github.com/elephant-xyz/elephant-mcp/issues/6)) ([bbd547c](https://github.com/elephant-xyz/elephant-mcp/commit/bbd547c9fd99874127a1b6f0cee4fe336cb4585a))

# Changelog

All notable changes will be documented here by semantic-release.
