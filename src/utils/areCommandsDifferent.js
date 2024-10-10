/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
module.exports = (existingCommand, localCommand) => {
    const areChoicesDifferent = (existingChoices, localChoices) => {
      for (const localChoice of localChoices) {
        const existingChoice = existingChoices?.find(
          (choice) => choice.name === localChoice.name
        );
  
        if (!existingChoice) {
          return true;
        }
  
        if (localChoice.value !== existingChoice.value) {
          return true;
        }
      }
      return false;
    };
  
    const areOptionsDifferent = (existingOptions, localOptions) => {
      for (const localOption of localOptions) {
        const existingOption = existingOptions?.find(
          (option) => option.name === localOption.name
        );
  
        if (!existingOption) {
          return true;
        }
  
        if (
          localOption.description !== existingOption.description ||
          localOption.type !== existingOption.type ||
          (localOption.required || false) !== existingOption.required ||
          (localOption.choices?.length || 0) !==
            (existingOption.choices?.length || 0) ||
          areChoicesDifferent(
            localOption.choices || [],
            existingOption.choices || []
          )
        ) {
          return true;
        }
      }
      return false;
    };
  
    if (
      existingCommand.description !== localCommand.description ||
      existingCommand.options?.length !== (localCommand.options?.length || 0) ||
      areOptionsDifferent(existingCommand.options, localCommand.options || [])
    ) {
      return true;
    }
  
    return false;
};