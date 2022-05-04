/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as byline from 'byline';
import { rgPath } from '@vscode/ripgrep';
import * as Parser from 'tree-sitter';
import fetch from 'node-fetch';
const { typescript } = require('tree-sitter-typescript');
const product = require('../../product.json');

type NlsString = { value: string; nlsKey: string };

function isNlsString(value: string | NlsString | undefined): value is NlsString {
	return value ? typeof value !== 'string' : false;
}

function isStringArray(value: (string | NlsString)[]): value is string[] {
	return !value.some(s => isNlsString(s));
}

function isNlsStringArray(value: (string | NlsString)[]): value is NlsString[] {
	return value.every(s => isNlsString(s));
}

interface Category {
	readonly name: NlsString;
}

enum PolicyType {
	StringEnum
}

interface Policy {
	readonly category: Category;
	readonly minimumVersion: string;
	renderADMX(regKey: string): string[];
	renderADMLStrings(translations?: LanguageTranslations): string[];
	renderADMLPresentation(): string;
}

abstract class BasePolicy implements Policy {
	constructor(
		protected policyType: PolicyType,
		protected name: string,
		readonly category: Category,
		readonly minimumVersion: string,
		protected description: NlsString,
		protected moduleName: string,
	) { }

	protected renderADMLString(nlsString: NlsString, translations?: LanguageTranslations): string {
		let value: string | undefined;

		if (translations) {
			const moduleTranslations = translations[this.moduleName];

			if (moduleTranslations) {
				value = moduleTranslations[nlsString.nlsKey];
			}
		}

		if (!value) {
			value = nlsString.value;
		}

		return `<string id="${this.name}_${nlsString.nlsKey}">${value}</string>`;
	}

	renderADMX(regKey: string) {
		return [
			`<policy name="${this.name}" class="Both" displayName="$(string.${this.name})" explainText="$(string.${this.name}_${this.description.nlsKey})" key="Software\\Policies\\Microsoft\\${regKey}" presentation="$(presentation.${this.name})">`,
			`	<parentCategory ref="${this.category.name.nlsKey}" />`,
			`	<supportedOn ref="Supported_${this.minimumVersion.replace(/\./g, '_')}" />`,
			`	<elements>`,
			...this.renderADMXElements(),
			`	</elements>`,
			`</policy>`
		];
	}

	protected abstract renderADMXElements(): string[];

	renderADMLStrings(translations?: LanguageTranslations) {
		return [
			`<string id="${this.name}">${this.name}</string>`,
			this.renderADMLString(this.description, translations)
		];
	}

	renderADMLPresentation(): string {
		return `<presentation id="${this.name}">${this.renderADMLPresentationContents()}</presentation>`;
	}

	protected abstract renderADMLPresentationContents(): string;
}

class StringEnumPolicy extends BasePolicy {
	constructor(
		name: string,
		category: Category,
		minimumVersion: string,
		description: NlsString,
		moduleName: string,
		protected enum_: string[],
		protected enumDescriptions: NlsString[],
	) {
		super(PolicyType.StringEnum, name, category, minimumVersion, description, moduleName);
	}

	protected renderADMXElements(): string[] {
		return [
			`<enum id="${this.name}" valueName="${this.name}">`,
			...this.enum_.map((value, index) => `	<item displayName="$(string.${this.name}_${this.enumDescriptions[index].nlsKey})"><value><string>${value}</string></value></item>`),
			`</enum>`
		];
	}

	renderADMLStrings(translations?: LanguageTranslations) {
		return [
			...super.renderADMLStrings(translations),
			...this.enumDescriptions.map(e => this.renderADMLString(e, translations))
		];
	}

	renderADMLPresentationContents() {
		return `<dropdownList refId="${this.name}" />`;
	}
}

// ---

interface QType<T> {
	Q: string;
	value(matches: Parser.QueryMatch[]): T | undefined;
}

const StringQ: QType<string | NlsString> = {
	Q: `[
		(string (string_fragment) @value)
		(call_expression function: (identifier) @localizeFn arguments: (arguments (string (string_fragment) @nlsKey) (string (string_fragment) @value)) (#eq? @localizeFn localize))
	]`,

	value(matches: Parser.QueryMatch[]): string | NlsString | undefined {
		const match = matches[0];

		if (!match) {
			return undefined;
		}

		const value = match.captures.filter(c => c.name === 'value')[0]?.node.text;

		if (!value) {
			throw new Error(`Missing required 'value' property.`);
		}

		const nlsKey = match.captures.filter(c => c.name === 'nlsKey')[0]?.node.text;

		if (nlsKey) {
			return { value, nlsKey };
		} else {
			return value;
		}
	}
};

const StringArrayQ: QType<(string | NlsString)[]> = {
	Q: `(array ${StringQ.Q})`,

	value(matches: Parser.QueryMatch[]): (string | NlsString)[] | undefined {
		return matches.map(match => {
			return StringQ.value([match]) as string | NlsString;
		});
	}
};

function getProperty<T>(qtype: QType<T>, node: Parser.SyntaxNode, key: string): T | undefined {
	const query = new Parser.Query(
		typescript,
		`(
			(pair
				key: [(property_identifier)(string)] @key
				value: ${qtype.Q}
			)
			(#eq? @key ${key})
		)`
	);

	return qtype.value(query.matches(node));
}

function getStringProperty(node: Parser.SyntaxNode, key: string): string | NlsString | undefined {
	return getProperty(StringQ, node, key);
}

function getStringArrayProperty(node: Parser.SyntaxNode, key: string): (string | NlsString)[] | undefined {
	return getProperty(StringArrayQ, node, key);
}

// ---

function getPolicy(moduleName: string, settingNode: Parser.SyntaxNode, policyNode: Parser.SyntaxNode, categories: Map<string, Category>): Policy {
	const name = getStringProperty(policyNode, 'name');

	if (!name) {
		throw new Error(`Missing required 'name' property.`);
	}

	if (isNlsString(name)) {
		throw new Error(`Property 'name' should be a literal string.`);
	}

	const minimumVersion = getStringProperty(policyNode, 'minimumVersion');

	if (!minimumVersion) {
		throw new Error(`Missing required 'minimumVersion' property.`);
	}

	if (isNlsString(minimumVersion)) {
		throw new Error(`Property 'minimumVersion' should be a literal string.`);
	}

	const description = getStringProperty(settingNode, 'description');

	if (!description) {
		throw new Error(`Missing required 'description' property.`);
	}

	if (!isNlsString(description)) {
		throw new Error(`Property 'description' should be localized.`);
	}

	const type = getStringProperty(settingNode, 'type');

	if (!type) {
		throw new Error(`Missing required 'type' property.`);
	}

	if (type !== 'string') {
		throw new Error(`Can't create policy from setting type '${type}' (needs implementing)`);
	}

	const enum_ = getStringArrayProperty(settingNode, 'enum');

	if (!enum_) {
		throw new Error(`Missing required 'enum' property.`);
	}

	if (!isStringArray(enum_)) {
		throw new Error(`Property 'enum' should not be localized.`);
	}

	const enumDescriptions = getStringArrayProperty(settingNode, 'enumDescriptions');

	if (!enumDescriptions) {
		throw new Error(`Missing required 'enumDescriptions' property.`);
	}

	if (!isNlsStringArray(enumDescriptions)) {
		throw new Error(`Property 'enumDescriptions' should be localized.`);
	}

	const categoryName = getStringProperty(policyNode, 'category');

	if (!categoryName) {
		throw new Error(`Missing required 'category' property.`);
	} else if (!isNlsString(categoryName)) {
		throw new Error(`Property 'category' should be localized.`);
	}

	const categoryKey = `${categoryName.nlsKey}:${categoryName.value}`;
	let category = categories.get(categoryKey);

	if (!category) {
		category = { name: categoryName };
		categories.set(categoryKey, category);
	}

	return new StringEnumPolicy(name, category, minimumVersion, description, moduleName, enum_, enumDescriptions);
}

function getPolicies(moduleName: string, node: Parser.SyntaxNode): Policy[] {
	const query = new Parser.Query(typescript, `
		(
			(call_expression
				function: (member_expression object: (identifier) property: (property_identifier) @registerConfigurationFn) (#eq? @registerConfigurationFn registerConfiguration)
				arguments: (arguments	(object	(pair
					key: [(property_identifier)(string)] @propertiesKey (#eq? @propertiesKey properties)
					value: (object (pair
						key: [(property_identifier)(string)]
						value: (object (pair
							key: [(property_identifier)(string)] @policyKey (#eq? @policyKey policy)
							value: (object) @policy
						))
					)) @setting
				)))
			)
		)
	`);

	const categories = new Map<string, Category>();

	return query.matches(node).map(m => {
		const settingNode = m.captures.filter(c => c.name === 'setting')[0].node;
		const policyNode = m.captures.filter(c => c.name === 'policy')[0].node;
		return getPolicy(moduleName, settingNode, policyNode, categories);
	});
}

// ---

async function getFiles(root: string): Promise<string[]> {
	return new Promise((c, e) => {
		const result: string[] = [];
		const rg = spawn(rgPath, ['-l', 'registerConfiguration\\(', '-g', 'src/**/*.ts', '-g', '!src/**/test/**', root]);
		const stream = byline(rg.stdout.setEncoding('utf8'));
		stream.on('data', path => result.push(path));
		stream.on('error', err => e(err));
		stream.on('end', () => c(result));
	});
}

// ---

function renderADMX(regKey: string, versions: string[], categories: Category[], policies: Policy[]) {
	versions = versions.map(v => v.replace(/\./g, '_'));

	return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.1" schemaVersion="1.0">
	<policyNamespaces>
		<target prefix="${regKey}" namespace="Microsoft.Policies.${regKey}" />
	</policyNamespaces>
	<resources minRequiredRevision="1.0" />
	<supportedOn>
		<definitions>
			${versions.map(v => `<definition name="Supported_${v}" displayName="$(string.Supported_${v})" />`).join(`\n			`)}
		</definitions>
	</supportedOn>
	<categories>
		<category displayName="$(string.Application)" name="Application" />
		${categories.map(c => `<category displayName="$(string.Category_${c.name.nlsKey})" name="${c.name.nlsKey}"><parentCategory ref="Application" /></category>`).join(`\n		`)}
	</categories>
	<policies>
		${policies.map(p => p.renderADMX(regKey)).flat().join(`\n		`)}
	</policies>
</policyDefinitions>
`;
}

function renderADML(appName: string, versions: string[], categories: Category[], policies: Policy[], translations?: LanguageTranslations) {
	return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources revision="1.0" schemaVersion="1.0">
	<displayName />
	<description />
	<resources>
		<stringTable>
			<string id="Application">${appName}</string>
			${versions.map(v => `<string id="Supported_${v.replace(/\./g, '_')}">${appName} &gt;= ${v}</string>`)}
			${categories.map(c => `<string id="Category_${c.name.nlsKey}">${c.name.value}</string>`)}
			${policies.map(p => p.renderADMLStrings(translations)).flat().join(`\n			`)}
		</stringTable>
		<presentationTable>
			${policies.map(p => p.renderADMLPresentation()).join(`\n			`)}
		</presentationTable>
	</resources>
</policyDefinitionResources>
`;
}

function renderGP(policies: Policy[], translations: Translations) {
	const appName = product.nameLong;
	const regKey = product.win32RegValueName;

	const versions = [...new Set(policies.map(p => p.minimumVersion)).values()].sort();
	const categories = [...new Set(policies.map(p => p.category))];

	return {
		admx: renderADMX(regKey, versions, categories, policies),
		adml: [
			{ languageId: 'en-us', contents: renderADML(appName, versions, categories, policies) },
			...translations.map(({ languageId, languageTranslations }) =>
				({ languageId, contents: renderADML(appName, versions, categories, policies, languageTranslations) }))
		]
	};
}

// ---

const Languages = {
	'fr': 'fr-fr',
	'it': 'it-it',
	'de': 'de-de',
	'es': 'es-es',
	'ru': 'ru-ru',
	'zh-hans': 'zh-cn',
	'zh-hant': 'zh-tw',
	'ja': 'ja-jp',
	'ko': 'ko-kr',
	'cs': 'cs-cz',
	'pt-br': 'pt-br',
	'tr': 'tr-tr',
	'pl': 'pl-pl',
};

type LanguageTranslations = { [moduleName: string]: { [nlsKey: string]: string } };
type Translations = { languageId: string; languageTranslations: LanguageTranslations }[];

async function getLatestStableVersion(updateUrl: string) {
	const res = await fetch(`${updateUrl}/api/update/darwin/stable/latest`);
	const { name: version } = await res.json() as { name: string };
	return version;
}

async function getNLS(resourceUrlTemplate: string, languageId: string, version: string) {
	const resource = {
		publisher: 'ms-ceintl',
		name: `vscode-language-pack-${languageId}`,
		version,
		path: 'extension/translations/main.i18n.json'
	};

	const url = resourceUrlTemplate.replace(/\{([^}]+)\}/g, (_, key) => resource[key as keyof typeof resource]);
	const res = await fetch(url);
	const { contents: result } = await res.json() as { contents: LanguageTranslations };
	return result;
}

// ---

async function parsePolicies(): Promise<Policy[]> {
	const parser = new Parser();
	parser.setLanguage(typescript);

	const files = await getFiles(process.cwd());
	const base = path.join(process.cwd(), 'src');
	const policies = [];

	for (const file of files) {
		const moduleName = path.relative(base, file).replace(/\.ts$/i, '').replace(/\\/g, '/');
		const contents = await fs.readFile(file, { encoding: 'utf8' });
		const tree = parser.parse(contents);
		policies.push(...getPolicies(moduleName, tree.rootNode));
	}

	return policies;
}

async function getTranslations(): Promise<Translations> {
	const updateUrl = product.updateUrl;

	if (!updateUrl) {
		console.warn(`Skipping policy localization: No 'updateUrl' found in 'product.json'.`);
		return [];
	}

	const resourceUrlTemplate = product.extensionsGallery?.resourceUrlTemplate;

	if (!resourceUrlTemplate) {
		console.warn(`Skipping policy localization: No 'resourceUrlTemplate' found in 'product.json'.`);
		return [];
	}

	const version = await getLatestStableVersion(updateUrl);
	const languageIds = Object.keys(Languages);

	return await Promise.all(languageIds.map(
		languageId => getNLS(resourceUrlTemplate, languageId, version)
			.then(languageTranslations => ({ languageId, languageTranslations }))
	));
}

async function main() {
	const [policies, translations] = await Promise.all([parsePolicies(), getTranslations()]);
	const { admx, adml } = await renderGP(policies, translations);

	const root = '.build/policies/win32';
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });

	await fs.writeFile(path.join(root, `${product.win32RegValueName}.admx`), admx.replace(/\r?\n/g, '\n'));

	for (const { languageId, contents } of adml) {
		const languagePath = path.join(root, languageId === 'en-us' ? 'en-us' : Languages[languageId as keyof typeof Languages]);
		await fs.mkdir(languagePath, { recursive: true });
		await fs.writeFile(path.join(languagePath, `${product.win32RegValueName}.adml`), contents.replace(/\r?\n/g, '\n'));
	}
}

if (require.main === module) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
