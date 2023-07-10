// @ts-check

const ms = require('ms');
const chalk = require('chalk');
const { Directus } = require('@directus/sdk');
const { sourceNodes, createSchemaCustomization } = require('gatsby-source-graphql/gatsby-node');
const { createRemoteFileNode } = require('gatsby-source-filesystem');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/**
 * Validate plugin options
 */
exports.pluginOptionsSchema = ({ Joi }) => {
	return Joi.object().keys({
		url: Joi.string().required(),
		auth: Joi.object()
			.keys({
				token: Joi.string(),
				email: Joi.string(),
				password: Joi.string(),
			})
			.with('email', 'password')
			.with('password', 'email')
			.xor('token', 'email'),
		type: Joi.object()
			.keys({
				name: Joi.string(),
				field: Joi.string(),
			})
			.optional(),
		dev: Joi.object().keys({
			refresh: [Joi.number(), Joi.string()],
		}),
		graphql: Joi.object(),
		concurrency: Joi.number().default(10),
		retries: Joi.number().default(5),
	});
};

/**
 * Gatsby source implementation.
 */

exports.sourceNodes = async (gatsbyOptions, pluginOptions) => {
	const {
		actions: { createNode, touchNode },
		createNodeId,
		store,
		cache,
		reporter,
		getNode,
	} = gatsbyOptions;
	const { headers } = await plugin.getOptions();
	const { Authorization } = await headers();

	await plugin.setOptions(pluginOptions);

	const optionsSystem = plugin.getOptionsSystem();
	const options = plugin.getOptions();

	// Avoid type conflict with gatsby-source-graphql
	gatsbyOptions.actions.createNode = (node) => {
		if (node.internal.type === 'GraphQLSource') {
			if (node.typeName === optionsSystem.typeName) node.internal.type = 'DirectusSystemGraphQLSource';
			if (node.typeName === options.typeName) node.internal.type = 'DirectusGraphQLSource';
		}

		return createNode(node);
	};

	await sourceNodes(gatsbyOptions, optionsSystem);
	await sourceNodes(gatsbyOptions, options);

	// Load files here rather than on file resolution.
	// Create a node for each file and store it in the cache
	// so it can bre retrieved on file resolution.
	for await (const files of plugin.iterateFiles()) {
		if (!files?.length) break;

		await Promise.all(
			files.map(async (file) => {
				const cached = await cache.get(file.id);
				const node = cached && getNode(cached.nodeId);

				if (node) {
					touchNode(node);
					return;
				}

				const nameParts = file.filename_download.split('.');
				const ext = nameParts.length > 1 ? `.${nameParts.pop()}` : '';
				const name = nameParts.join('.');
				const fileUrl = `${plugin.url}assets/${file.id}`;
				const fileNode = await createRemoteFileNode({
					url: fileUrl,
					parentNodeId: file.id,
					store,
					cache,
					createNode,
					createNodeId,
					httpHeaders: { Authorization },
					reporter,
					ext,
					name,
				});
				await cache.set(file.id, { nodeId: fileNode.id });
			})
		);
	}
};

exports.createSchemaCustomization = async (gatsby, pluginOptions) => {
	await plugin.setOptions(pluginOptions);

	await createSchemaCustomization(gatsby, plugin.getOptionsSystem());
	await createSchemaCustomization(gatsby, plugin.getOptions());
};

/**
 * Gatsby file implementation.
 */
exports.createResolvers = async ({ cache, createResolvers, getNode }, pluginOptions) => {
	await plugin.setOptions(pluginOptions);

	const fileResolver = {
		imageFile: {
			type: `File`,
			async resolve(source) {
				const cached = await cache.get(source.id);
				if (cached) return getNode(cached.nodeId);
				throw new Error('Cached image not found for id: ' + source.id);
			},
		},
	};

	await createResolvers({
		DirectusData_directus_files: fileResolver,
		DirectusSystemData_directus_files: fileResolver,
	});
};

class Plugin {
	constructor() {
		// eslint-disable-next-line no-undef
		this.fileCache = new Map();
		this.directus = null;
		this.options = null;
		this.urlGraphqlSystem = '';
		this.urlGraphql = '';
		this.url = '';
		this.refreshInterval = 0;
		this.authPromise = null;
		this.concurrency = 10;
		this.retries = 5;
	}

	async setOptions(options) {
		const { url, dev, auth, concurrency, retries } = options;

		if (isEmpty(url)) error('"url" must be defined');

		if (this.directus) return this.authPromise;

		const hasAuth = !!auth;
		const hasToken = !isEmpty(auth?.token);
		const hasEmail = !isEmpty(auth?.email);
		const hasPassword = !isEmpty(auth?.password);
		const hasCredentials = hasEmail && hasPassword;

		if (hasAuth) {
			if (!hasToken && !hasCredentials) error('"auth.token" or ("auth.email" and "auth.password") must be defined');
		} else warning('no "auth" option were defined. Resources will be fetched with public role');

		try {
			const baseUrl = new URL(url);
			const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;

			baseUrl.pathname = basePath;
			this.url = baseUrl.toString();

			baseUrl.pathname = basePath + '/graphql';
			this.urlGraphql = baseUrl.toString();

			baseUrl.pathname = basePath + '/graphql/system';
			this.urlGraphqlSystem = baseUrl.toString();
		} catch (err) {
			error('"url" should be a valid URL');
		}

		try {
			this.directus = new Directus(this.url);

			if (hasToken) this.authPromise = await this.directus.auth.static(auth.token);

			if (hasCredentials)
				this.authPromise = await this.directus.auth.login({ email: auth?.email, password: auth?.password });
		} catch (err) {
			error(`authentication failed with: ${err.message}\nAre credentials valid?`);
		}

		this.refreshInterval = typeof dev?.refresh === 'string' ? ms(dev.refresh) / 1000 : dev?.refresh || 15;

		if (Number.isNaN(this.refreshInterval))
			error('"dev.refresh" should be a number in seconds or a string with ms format, i.e. 5s, 5m, 5h, ...');

		this.options = options;
		this.concurrency = concurrency;
		this.retries = retries;

		return this.authPromise;
	}

	getOptions() {
		const internalOptions = ['url', 'dev', 'auth', 'type'];
		const gatsbyPluginOptions = Object.fromEntries(
			Object.entries(this.options).flatMap(([key, value]) => (internalOptions.includes(key) ? [] : [[key, value]]))
		);

		return {
			...this.options.graphql,
			...gatsbyPluginOptions,
			url: this.urlGraphql,
			typeName: this.options?.type?.name || 'DirectusData',
			fieldName: this.options?.type?.field || 'directus',
			headers: this.headers.bind(this),
			fetch: async (uri, options) => {
				function request() {
					return nodeFetch(uri, options);
				}

				let count = 0;
				let response = null;
				let error = null;

				while (response === null && count++ < this.retries) {
					try {
						response = await request();
					} catch (err) {
						error = err;
					}

					if (count > 0) {
						await sleep(Math.pow(2, count) * 1000);
					}
				}

				if (response === null) throw error;

				return response;
			},
		};
	}

	getOptionsSystem() {
		const options = this.getOptions();

		return {
			...options,
			url: this.urlGraphqlSystem,
			typeName: this.options?.type?.system_name || 'DirectusSystemData',
			fieldName: this.options?.type?.system_field || 'directus_system',
		};
	}

	async *iterateFiles() {
		if (!this.directus) throw new Error('Directus is not instantiated');

		let hasMore = true;
		let page = 1;

		while (hasMore) {
			if (!this.directus) throw new Error('Directus is not instantiated');

			const files = await this.directus.files
				.readByQuery({
					fields: ['id', 'type', 'filename_download'],
					sort: ['id'],
					limit: this.concurrency,
					page,
				})
				.then((r) => r?.data ?? []);

			yield files;

			if (files.length < this.concurrency) {
				hasMore = false;
			} else {
				page++;
			}
		}
	}

	async headers() {
		if (!this.directus) throw new Error('Directus is not instantiated');

		let headers = {};
		if (typeof this.options?.headers === 'object') {
			Object.assign(headers, this.options.headers || {});
		} else if (typeof this.options?.headers === 'function') {
			Object.assign(headers, (await this.options.headers()) || {});
		}

		const token = await this.directus.auth.token;

		if (token) {
			Object.assign(headers, {
				Authorization: `Bearer ${token}`,
			});
		}

		return headers;
	}
}

class Log {
	static log(level, message) {
		let color = level === 'error' ? 'red' : level === 'warning' ? 'yellow' : 'white';

		// eslint-disable-next-line no-console
		console.log(chalk.cyan('gatsby-source-directus'), ':', chalk[color](message));
	}
	static error(message) {
		Log.log('error', message);
	}
	static warning(message) {
		Log.log('error', message);
	}
}

function isEmpty(value) {
	if (value?.constructor === String) return value.length === 0;

	return true;
}

function error(message) {
	Log.error(message);

	const error = new Error(`gatsby-source-directus: ${message}`);
	error.stack = undefined;

	throw error;
}

function warning(message) {
	Log.warning(message);
}

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

const plugin = new Plugin();
