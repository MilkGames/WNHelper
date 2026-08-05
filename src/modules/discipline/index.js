/*
 * WN Helper Discord Bot
 * Copyright (C) 2026 MilkGames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
const appealPresentation = require('./appealPresentation');
const appealService = require('./appealService');
const disciplineCommand = require('./commands/discipline');
const massDisciplineCommand = require('./commands/massDiscipline');
const DisciplineError = require('./error');
const events = require('./events');
const handlers = require('./settings/handlers');
const renderer = require('./settings/renderer');
const schema = require('./settings/schema');
const service = require('./service');
const massService = require('./massService');
const policy = require('./policy');
const presentation = require('./presentation');

module.exports = {
    name: 'discipline',
    commands: [disciplineCommand, massDisciplineCommand],
    events,
    actions: {
        'discipline.assertOrdinaryDismissalAllowed': service.assertOrdinaryDismissalAllowed,
        'discipline.assertPromotionAllowed': service.assertPromotionAllowed,
        'discipline.closeExternalDiscipline': service.closeExternalDiscipline,
        'discipline.closeMemberDiscipline': service.closeMemberDiscipline,
        'discipline.handleUvalRejected': service.handleUvalRejected,
        'discipline.issueCase': service.issueCase,
        'discipline.recordRecertificationExamResult': service.recordRecertificationExamResult,
        'discipline.refreshBatchMessages': massService.refreshBatchMessages,
        'discipline.setMemberVacationPause': service.setMemberVacationPause,
    },
    DisciplineError,
    ...appealPresentation,
    ...appealService,
    ...handlers,
    ...renderer,
    ...schema,
    ...service,
    ...massService,
    ...policy,
    ...presentation,
};
