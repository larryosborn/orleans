import { describe, it, expect } from 'vitest';
import { stopwordRatio, isBoilerplateChunk } from './boilerplate';

// Real low-signal chunks captured verbatim from a live Orleans crawl — the
// nav/menu/index/form/footer chrome #59 must keep out of the vector index. Each
// leaks through readability off a nav-heavy landing/index page.
const HOW_DO_I_INDEX =
	'Government Community Business Visiting Orleans How Do I... HomeHow Do I... A A ' +
	'Click the button to sign up for emergency alerts. Click the button to sign up for ' +
	'website notifications. 9 2 2 3 Employment Opportunities Beach and OSV Stickers ' +
	'Passports Building Permits Senior Tax Work-Off Program Universal Pre-K Program ' +
	'Rental Registration Departments & Staff Police Department Select Board Flood Map ' +
	'Information Channel 1072 Live Stream CivicReady Emergency Alerts NotifyMe Website ' +
	'Notifications EyeOnWater Voting Recreation Activities Video Archive Requests Online ' +
	'Payments Parking Ticket Payments (In Person) Parking Ticket Payments (Mail)';
const AGENDA_CENTER_INDEX =
	'HomeAgenda Center View current agendas and minutes for all boards and commissions. ' +
	'Search Agendas by: Time Period Enter Search Terms Select a Category Search 141 ' +
	'Portanimicut Road Task Force 2021 2020 Building Code of Appeals 2022 Community Center ' +
	'Feasibility Task Force 2022 2021 Fire-Rescue Building Committee 2026 2025 Governor ' +
	'Prence Planning Committee 2022 2021 Long Range Capital Planning Committee 2024 2023';
const CONTACT_FOOTER =
	'Contact Us 19 School RoadOrleans, MA 02653Phone: 508-240-3700Fax: 508-240-3388' +
	'Town Hall Hours M - F 8:30 AM to 4:30 PMPassport Hours T - T 8:30 AM to 12PM, 1PM to 4PM';
const DIRECTORY_FORM = 'Category: First Name: Last Name: Search';

// Genuine content (FAQ answer / policy prose) from the same crawl — must be kept.
const FAQ_ANSWER =
	'An abatement is a reduction in your property’s assessment that you can apply for ' +
	'if you believe that assessment does not accurately reflect the property’s market value. ' +
	'You should seek an abatement if you believe one of the following applies to your property.';
const POLICY_TEXT =
	'The Town of Orleans remains in a significant drought and has implemented mandatory ' +
	'water use restrictions. Outdoor watering is permitted between 5:00 PM and 9:00 AM using ' +
	'hand-held hoses, watering cans, or drip irrigation. Limited exceptions are in place.';

describe('stopwordRatio (content density)', () => {
	it('is below the default floor for nav/index/form/footer chrome', () => {
		// All measured well under 0.2 on the real corpus (0.0–0.19).
		expect(stopwordRatio(HOW_DO_I_INDEX)).toBeLessThan(0.2);
		expect(stopwordRatio(AGENDA_CENTER_INDEX)).toBeLessThan(0.2);
		expect(stopwordRatio(CONTACT_FOOTER)).toBeLessThan(0.2);
		expect(stopwordRatio(DIRECTORY_FORM)).toBeLessThan(0.2);
	});

	it('is well above the floor for genuine prose', () => {
		expect(stopwordRatio(FAQ_ANSWER)).toBeGreaterThan(0.3);
		expect(stopwordRatio(POLICY_TEXT)).toBeGreaterThan(0.3);
	});

	it('scores empty / word-free text as 0', () => {
		expect(stopwordRatio('')).toBe(0);
		expect(stopwordRatio('   \n\n ')).toBe(0);
		expect(stopwordRatio('!!! —— 123 456')).toBe(0);
	});
});

describe('isBoilerplateChunk', () => {
	it('flags nav/index/form/footer chrome as boilerplate', () => {
		expect(isBoilerplateChunk(HOW_DO_I_INDEX)).toBe(true);
		expect(isBoilerplateChunk(AGENDA_CENTER_INDEX)).toBe(true);
		expect(isBoilerplateChunk(CONTACT_FOOTER)).toBe(true);
		expect(isBoilerplateChunk(DIRECTORY_FORM)).toBe(true);
	});

	it('keeps genuine FAQ / policy content', () => {
		expect(isBoilerplateChunk(FAQ_ANSWER)).toBe(false);
		expect(isBoilerplateChunk(POLICY_TEXT)).toBe(false);
	});

	it('honors an explicit threshold (tunable knob)', () => {
		// A stricter floor drops borderline prose; a looser one keeps chrome.
		expect(isBoilerplateChunk(FAQ_ANSWER, 0.9)).toBe(true);
		expect(isBoilerplateChunk(HOW_DO_I_INDEX, 0.05)).toBe(false);
	});

	it('is disabled when the threshold is 0 (or negative)', () => {
		expect(isBoilerplateChunk(HOW_DO_I_INDEX, 0)).toBe(false);
		expect(isBoilerplateChunk(DIRECTORY_FORM, 0)).toBe(false);
		expect(isBoilerplateChunk('', 0)).toBe(false);
	});
});
