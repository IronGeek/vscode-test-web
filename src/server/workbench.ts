/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { promises as fs } from 'fs';
import { URI } from 'vscode-uri';
import * as Router from '@koa/router';

import { IConfig } from './main';
import { scanForExtensions, URIComponents } from './extensions';
import { fetch, fetchJSON } from './download';
import { fsProviderExtensionPrefix, fsProviderFolderUri } from './mounts';

interface IDevelopmentOptions {
	extensionTestsPath?: URIComponents;
	extensions?: URIComponents[];
}
interface IWorkbenchOptions {
	additionalBuiltinExtensions?: (string | URIComponents)[];
	developmentOptions?: IDevelopmentOptions;
	folderUri?: URIComponents;
}

function asJSON(value: unknown): string {
	return JSON.stringify(value).replace(/"/g, '&quot;');
}

class Workbench {
	constructor(readonly baseUrl: string, readonly dev: boolean, private readonly builtInExtensions: unknown[] = []) { }

	async render(workbenchWebConfiguration: IWorkbenchOptions): Promise<string> {
		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: '',
			WORKBENCH_WEB_BASE_URL: this.baseUrl,
			WORKBENCH_BUILTIN_EXTENSIONS: asJSON(this.builtInExtensions),
			WORKBENCH_MAIN: this.getMain()
		};

		try {
			const workbenchTemplate = (await fs.readFile(path.resolve(__dirname, '../../views/workbench.html'))).toString();
			return workbenchTemplate.replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? 'undefined');
		} catch (e) {
			return String(e);
		}
	}

	getMain() {
		return this.dev
			? `<script> require(['vs/code/browser/workbench/workbench'], function() {}); </script>`
			: `<script src="${this.baseUrl}/out/vs/workbench/workbench.web.api.nls.js"></script>`
			+ `<script src="${this.baseUrl}/out/vs/workbench/workbench.web.api.js"></script>`
			+ `<script src="${this.baseUrl}/out/vs/code/browser/workbench/workbench.js"></script>`;
	}


	async renderCallback(): Promise<string> {
		return await fetch(`${this.baseUrl}/out/vs/code/browser/workbench/callback.html`);
	}
}

function valueOrFirst<T>(value: T | T[] | undefined): T | undefined {
	return Array.isArray(value) ? value[0] : value;
}


async function getWorkbenchOptions(
	ctx: { protocol: string; host: string },
	config: IConfig
): Promise<IWorkbenchOptions> {
	const options: IWorkbenchOptions = {};
	if (config.extensionPaths) {
		await Promise.all(config.extensionPaths.map(async (extensionPath, index) => {
			options.additionalBuiltinExtensions = await scanForExtensions(extensionPath, {
				scheme: ctx.protocol,
				authority: ctx.host,
				path: `/static/extensions/${index}`,
			});
		}));
	}
	if (config.extensionDevelopmentPath) {
		const developmentOptions: IDevelopmentOptions = options.developmentOptions = {}

		developmentOptions.extensions = await scanForExtensions(
			config.extensionDevelopmentPath,
			{ scheme: ctx.protocol, authority: ctx.host, path: '/static/devextensions' },
		);
		if (config.extensionTestsPath) {
			let relativePath = path.relative(config.extensionDevelopmentPath, config.extensionTestsPath);
			if (process.platform === 'win32') {
				relativePath = relativePath.replace(/\\/g, '/');
			}
			developmentOptions.extensionTestsPath = {
				scheme: ctx.protocol,
				authority: ctx.host,
				path: path.posix.join('/static/devextensions', relativePath),
			};
		}
	}
	if (config.folderMountPath) {
		if (!options.additionalBuiltinExtensions) {
			options.additionalBuiltinExtensions = [];
		}
		options.additionalBuiltinExtensions.push({ scheme: ctx.protocol, authority: ctx.host, path: fsProviderExtensionPrefix });
		options.folderUri = URI.parse(fsProviderFolderUri);
	} else if (config.folderUri) {
		options.folderUri = URI.parse(config.folderUri);
	}
	return options;
}

export default function (config: IConfig): Router.Middleware {
	const router = new Router<{ workbench: Workbench }>();

	router.use(async (ctx, next) => {
		if (ctx.query['dev'] || config.build.type === 'sources') {
			try {
				const builtInExtensions = await fetchJSON<unknown[]>('http://localhost:8080/builtin');
				ctx.state.workbench = new Workbench('http://localhost:8080/static', true, builtInExtensions);
			} catch (err) {
				console.log(err);
				ctx.throw('Could not connect to localhost:8080, make sure you start `yarn web`', 400);
			}
		} else if (config.build.type === 'static') {
			ctx.state.workbench = new Workbench(`${ctx.protocol}://${ctx.host}/static/build`, false);
		} else if (config.build.type === 'cdn') {
			ctx.state.workbench = new Workbench(config.build.uri, false);
		}
		await next();
	});

	const callbacks = new Map<string, URI>();

	router.get('/callback', async ctx => {
		const {
			'vscode-requestId': vscodeRequestId,
			'vscode-scheme': vscodeScheme,
			'vscode-authority': vscodeAuthority,
			'vscode-path': vscodePath,
			'vscode-query': vscodeQuery,
			'vscode-fragment': vscodeFragment,
		} = ctx.query;

		if (!vscodeRequestId || !vscodeScheme || !vscodeAuthority) {
			return ctx.throw(400);
		}

		const requestId = valueOrFirst(vscodeRequestId)!;
		const uri = URI.from({
			scheme: valueOrFirst(vscodeScheme)!,
			authority: valueOrFirst(vscodeAuthority),
			path: valueOrFirst(vscodePath),
			query: valueOrFirst(vscodeQuery),
			fragment: valueOrFirst(vscodeFragment),
		});

		callbacks.set(requestId, uri);

		ctx.body = await ctx.state.workbench.renderCallback();
	});

	router.get('/fetch-callback', async ctx => {
		const { 'vscode-requestId': vscodeRequestId } = ctx.query;

		if (!vscodeRequestId) {
			return ctx.throw(400);
		}

		const requestId = valueOrFirst(vscodeRequestId)!;
		const uri = callbacks.get(requestId);

		if (!uri) {
			return ctx.throw(400);
		}

		callbacks.delete(requestId);
		ctx.body = uri.toJSON();
	});

	router.get('/', async ctx => {
		const options = await getWorkbenchOptions(ctx, config);
		ctx.body = await ctx.state.workbench.render(options);
	});

	//mountAPI(config, router);


	return router.routes();
}

