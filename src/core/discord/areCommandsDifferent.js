/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
function normalizeOptional(value) {
    return value === undefined ? null : value;
}

function normalizeArray(values) {
    return (Array.isArray(values) ? values : [])
        .map((value) => String(value))
        .sort();
}

function normalizeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

function areJsonValuesDifferent(left, right) {
    return JSON.stringify(left) !== JSON.stringify(right);
}

module.exports = (existingCommand, localCommand) => {
    const areChoicesDifferent = (existingChoices = [], localChoices = []) => {
        if (existingChoices.length !== localChoices.length) return true;

        for (const localChoice of localChoices) {
            const existingChoice = existingChoices.find(
                (choice) => choice.name === localChoice.name
            );

            if (
                !existingChoice ||
                localChoice.value !== existingChoice.value ||
                areJsonValuesDifferent(
                    normalizeObject(existingChoice.nameLocalizations),
                    normalizeObject(localChoice.nameLocalizations)
                )
            ) {
                return true;
            }
        }

        return false;
    };

    const areOptionsDifferent = (existingOptions = [], localOptions = []) => {
        if (existingOptions.length !== localOptions.length) return true;

        for (const localOption of localOptions) {
            const existingOption = existingOptions.find(
                (option) => option.name === localOption.name
            );

            if (!existingOption) return true;

            if (
                localOption.description !== existingOption.description ||
                localOption.type !== existingOption.type ||
                Boolean(localOption.required) !== Boolean(existingOption.required) ||
                Boolean(localOption.autocomplete) !== Boolean(existingOption.autocomplete) ||
                normalizeOptional(localOption.minValue) !== normalizeOptional(existingOption.minValue) ||
                normalizeOptional(localOption.maxValue) !== normalizeOptional(existingOption.maxValue) ||
                normalizeOptional(localOption.minLength) !== normalizeOptional(existingOption.minLength) ||
                normalizeOptional(localOption.maxLength) !== normalizeOptional(existingOption.maxLength) ||
                areJsonValuesDifferent(
                    normalizeArray(existingOption.channelTypes),
                    normalizeArray(localOption.channelTypes)
                ) ||
                areJsonValuesDifferent(
                    normalizeObject(existingOption.nameLocalizations),
                    normalizeObject(localOption.nameLocalizations)
                ) ||
                areJsonValuesDifferent(
                    normalizeObject(existingOption.descriptionLocalizations),
                    normalizeObject(localOption.descriptionLocalizations)
                ) ||
                areChoicesDifferent(existingOption.choices || [], localOption.choices || []) ||
                areOptionsDifferent(existingOption.options || [], localOption.options || [])
            ) {
                return true;
            }
        }

        return false;
    };

    return (
        existingCommand.description !== localCommand.description ||
        areOptionsDifferent(existingCommand.options || [], localCommand.options || [])
    );
};
