import _ from 'lodash';

/** Thrown when mapOne does not find an object in the resultSet and "isRequired" is passed in as true */
function NotFoundError(message = 'Not Found') {
    this.name = 'NotFoundError';
    this.message = message;
    this.stack = (new Error()).stack;
}

NotFoundError.prototype = Object.create(Error.prototype);
NotFoundError.prototype.constructor = NotFoundError;

/**
 * Maps a resultSet to an array of objects.
 *
 * @param {Array} resultSet - an array of database results
 * @param {Array} maps - an array of result maps
 * @param {String} mapId - mapId of the top-level objects in the resultSet
 * @param {String} [columnPrefix] - prefix that should be applied to the column names of the top-level objects
 * @returns {Array} array of mapped objects
 */
function map(resultSet, maps, mapId, columnPrefix) {

    let mappedCollection = [];

    _.each(resultSet, (result) => {
        injectResultInCollection(result, mappedCollection, maps, mapId, columnPrefix);
    });

    return mappedCollection;
}

/**
 * Maps a resultSet to a single object.
 *
 * Although the result is a single object, resultSet may have multiple results (e.g. when the
 * top-level object has many children in a one-to-many relationship). So mapOne() must still
 * call map(), only difference is that it will return only the first result.
 *
 * @param {Array} resultSet - an array of database results
 * @param {Array} maps - an array of result maps
 * @param {String} mapId - mapId of the top-level object in the resultSet
 * @param {String} [columnPrefix] - prefix that should be applied to the column names of the top-level object
 * @param {boolean} [isRequired] - is it required to have a mapped object as a return value? Default is true.
 * @returns {Object} one mapped object or null
 * @throws {NotFoundError} if object is not found and isRequired is true
 */
function mapOne(resultSet, maps, mapId, columnPrefix, isRequired = true) {

    var mappedCollection = map(resultSet, maps, mapId, columnPrefix);

    if (mappedCollection.length > 0) {
        return mappedCollection[0];
    }
    else if (isRequired) {
        throw new NotFoundError('EmptyResponse');
    }
    else {
        return null;
    }
}

/**
 * Maps a single database result to a single object using mapId and injects it into mappedCollection.
 *
 * @param {Object} result - a single database result (one row)
 * @param {Array} mappedCollection - the collection in which the mapped object should be injected.
 * @param {Array} maps - an array of result maps
 * @param {String} mapId - mapId of the top-level objects in the resultSet
 * @param {String} [columnPrefix] - prefix that should be applied to the column names of the top-level objects
 */
function injectResultInCollection(result, mappedCollection, maps, mapId, columnPrefix = '') {

    // Check if the object is already in mappedCollection
    let resultMap = _.find(maps, ['mapId', mapId]);

    let idProperties = getIdProperties(resultMap);
    let predicate = _.transform(idProperties, (accumulator, idProperty) => {
        if (idProperty.transform && resultMap.transform && typeof resultMap.transform === 'function') {
            transformResultField(resultMap, result, columnPrefix, idProperty);
        }
        return accumulator[idProperty.name] = result[columnPrefix + idProperty.column];
    }, {});
    let mappedObject = _.find(mappedCollection, predicate);

    // Inject only if the value of idProperty is not null (ignore joins to null records)
    let isIdPropertyNotNull = _.every(idProperties, idProperty => !_.isNull(result[columnPrefix + idProperty.column]));

    if (isIdPropertyNotNull) {
        // Create mappedObject if it does not exist in mappedCollection
        if (!mappedObject) {
            mappedObject = createMappedObject(resultMap);
            mappedCollection.push(mappedObject);
        }

        // Inject result in object
        injectResultInObject(result, mappedObject, maps, mapId, columnPrefix);
    }
}

/**
 * Injects id, properties, associations and collections to the supplied mapped object.
 *
 * @param {Object} result - a single database result (one row)
 * @param {Object} mappedObject - the object in which result needs to be injected
 * @param {Array} maps - an array of result maps
 * @param {String} mapId - mapId of the top-level objects in the resultSet
 * @param {String} [columnPrefix] - prefix that should be applied to the column names of the top-level objects
 */
function injectResultInObject(result, mappedObject, maps, mapId, columnPrefix = '') {

    // Get the resultMap for this object
    let resultMap = _.find(maps, ['mapId', mapId]);

    // Copy id property
    let idProperty = getIdProperties(resultMap);

    _.each(idProperty, field => {
        if (!mappedObject[field.name]) {
            mappedObject[field.name] = result[columnPrefix + field.column];
        }
    });


    // Copy other properties
    _.each(resultMap.properties, (property) => {
        // If property is a string, convert it to an object
        if (typeof property === 'string') {
            // eslint-disable-next-line
            property = {name: property, column: property, transform: true};
        }

        // unless explicitely specified, don't transform name for properties with column specification
        property.transform = property.transform || false;

        // eventually transform result keys matching properties
        if (property.transform && resultMap.transform && typeof resultMap.transform === 'function') {
            transformResultField(resultMap, result, columnPrefix, property);
        }

        // Copy only if property does not exist already
        if (!mappedObject[property.name]) {

            // The default for column name is property name
            let column = (property.column) ? property.column : property.name;
            mappedObject[property.name] = result[columnPrefix + column];
        }
    });

    // extend the mappedObject
    if (resultMap.extend && typeof resultMap.extend === 'function') {
        Object.assign(mappedObject, resultMap.extend(mappedObject));
    }

    // Copy associations
    _.each(resultMap.associations, (association) => {

        let associatedObject = mappedObject[association.name];

        if (!associatedObject) {
            let associatedResultMap = _.find(maps, ['mapId', association.mapId]);
            let associatedObjectIdProperty = getIdProperties(associatedResultMap);

            mappedObject[association.name] = null;

            // Don't create associated object if it's key value is null
            let isAssociatedObjectIdPropertyNotNull = _.every(
                associatedObjectIdProperty,
                field => !_.isNull(result[association.columnPrefix + field.column])
            );

            if (isAssociatedObjectIdPropertyNotNull) {
                associatedObject = createMappedObject(associatedResultMap);
                mappedObject[association.name] = associatedObject;
            }
        }

        if (associatedObject) {
            injectResultInObject(result, associatedObject, maps, association.mapId, association.columnPrefix);
        }
    });

    // Copy collections
    _.each(resultMap.collections, (collection) => {

        let mappedCollection = mappedObject[collection.name];

        if (!mappedCollection) {
            mappedCollection = [];
            mappedObject[collection.name] = mappedCollection;
        }

        injectResultInCollection(result, mappedCollection, maps, collection.mapId, collection.columnPrefix);
    });
}

function createMappedObject(resultMap) {
    return (resultMap.createNew) ? resultMap.createNew() : {};
}

function getIdProperties(resultMap) {

    if (!resultMap.idProperty) {
        return [{name: 'id', column: 'id', transform: false}];
    }

    let idProperties = resultMap.idProperty;

    if (!_.isArray(idProperties)) {
        idProperties = [idProperties];
    }

    return _.map(idProperties, idProperty => {

        // If property is a string, convert it to an object
        if (_.isString(idProperty)) {
            return {name: idProperty, column: idProperty, transform: true};
        } else {
            // unless explicitely specified, don't transform name for properties with column specification
            idProperty.transform = idProperty.transform || false;
        }

        // The default for column name is property name
        if (!idProperty.column) {
            idProperty.column = idProperty.name;
        }

        return idProperty;
    });
}

function transformResultField(resultMap, result, columnPrefix, property) {
    _.each(result, (value, field) => {
        const rawField = columnPrefix ? field.replace(new RegExp(`^${columnPrefix}`), '') : field;
        const transformedField = resultMap.transform(rawField);

        if (property.column === rawField || property.column === transformedField) {
            delete result[field];
            result[columnPrefix + transformedField] = value;
        }

    });
}

const joinjs = {
    map: map,
    mapOne: mapOne,
    NotFoundError: NotFoundError
};

export default joinjs;
