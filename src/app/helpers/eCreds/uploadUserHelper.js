/**
 * @name : uploadUserHelper.js
 * @description :: Responsible for generating, adding to registry , downloading certificates and uploading to azure for particular csv
 * @author      :: Ravinder Kumar
 */

const envHelper = require('../environmentVariablesHelper.js');
const csvjson = require('csvjson')
const _ = require('lodash')
const dateFormat = require('dateformat')
const uuidv1 = require('uuid/v1')
const path = require('path');
const azure = require('azure-storage');
const blobService = azure.createBlobService(envHelper.sunbird_azure_account_name, envHelper.sunbird_azure_account_key);
const fs = require('fs');
const { certAddRequestBody, certGenerateRequestBody } = require('./apiRequestBody');
const requestPromise = require("request-promise");
const async = require('async');
const https = require('https');
const baseDownloadDir = 'Downloads';
var zipFolder = require('zip-folder');
const cassandraUtil = require('./cassandraUtil');
const BATCH_SIZE = 10;

const validateName = (name) => name ? true : false;

const convertCsvToJson = (csv) => csvjson.toObject(csv);

const generateAndAddCertificates = (req) => {
    var rspObj = _.get(req, 'rspObj');
    const successRecords = [];
    const failureRecords = [];

    // updates the processstart time
    const update_values_object = {
        processstarttime: _.toString(new Date()),
        retrycount: 1,
        status: 1
    }
    cassandraUtil.updateData({ id: _.toString(_.get(rspObj, 'processId')) }, update_values_object, (err, result) => {
        if (err) {
            console.log('updating bulk_upload_process table processstarttime', _.get(err, 'message'))
        } else {
            console.log('successfully updated bulk_upload_process processstarttime', result);
        }
    })

    async.eachOfLimit(_.get(rspObj, 'jsonObj'), BATCH_SIZE, (data, key, cb) => {
        const name = _.get(data, 'Name');
        async.waterfall([async.constant({ name, rspObj }), generateCertificateApiCall, addCertificateApiCall,
            downloadCertificateApiCall, downloadCertificate], (err, result) => {
                if (!result && err) {
                    failureRecords.push({ name: data, status: 'failed', index: key });
                } else {
                    successRecords.push({ name: data, status: 'success', index: key });
                }
                cb();
            })
    }, (err) => {
        if (!err) {
            writeDataToCsv(_.get(rspObj, 'processId'), _.merge(successRecords, failureRecords));
            async.waterfall([async.constant(rspObj), prepareZip], (err, result) => {
                if (err) {
                    console.log('Error: ', _.get(err, 'message'));
                } else {
                    const query_obj = { id: _.toString(_.get(rspObj, 'processId')) };
                    const update_values_object = {
                        failureresult: JSON.stringify(_.map(failureRecords, 'name')),
                        successresult: JSON.stringify(_.map(successRecords, 'name')),
                        lastupdatedon: new Date(),
                        processendtime: _.toString(new Date()),
                        retrycount: 3,
                        storagedetails: result,
                        status: 2
                    }
                    cassandraUtil.updateData(query_obj, update_values_object, (err, result) => {
                        if (err) {
                            console.log('updating bulk_upload_process table failed', _.get(err, 'message'))
                        } else {
                            console.log('successfully updated bulk_upload_process table', result);
                        }
                    })
                }
            })
        }
    })
}

const uploadToAzure = (filePath, callback) => {
    // upload the file to blobStorage

}

const writeDataToCsv = (folder, data) => {
    const options = {
        headers: 'key'
    }
    const response = csvjson.toCSV(data, options);
    fs.writeFileSync(path.join(__dirname, `${baseDownloadDir}/${folder}/result.csv`), response);
}

const prepareZip = (rspObj, callback) => {
    const folder = _.get(rspObj, 'processId');
    const sourceDir = path.join(__dirname, `${baseDownloadDir}/${folder}`);
    const targetDir = path.join(__dirname, `${baseDownloadDir}/${folder}.zip`)

    zipFolder(sourceDir, targetDir, function (err) {
        if (err) {
            console.log('zip failed', err);
            callback(true, null);
        } else {
            console.log('zip successful');
            callback(null, targetDir);
        }
    });
}

const downloadCertificate = (input, signedUrl, certificateId, callback) => {
    const folder = _.get(input, 'rspObj.processId');
    const downloadDir = path.join(__dirname, `${baseDownloadDir}/${folder}`);
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
    const file = fs.createWriteStream(`${downloadDir}/${_.get(input, 'name')}_${certificateId}.pdf`);
    https.get(signedUrl, response => {
        response.on('data', (val) => {
            file.write(val);
        });
        response.on('end', val => {
            file.end();
            callback(null, true)
        });
        response.on('error', err => {
            callback(true, null);
        })
    });
}

const downloadCertificateApiCall = (input, { downloadUrl, certificateId, expiry = 3600 }, callback) => {
    const endPoint = 'certreg/v1/certs/download';
    const options = {
        method: 'POST',
        url: `${_.get(envHelper, 'LEARNER_URL')}${endPoint}`,
        headers: {
            'Authorization': `Bearer ${_.get(envHelper, 'PORTAL_API_AUTH_TOKEN')}`,
            'Content-Type': 'application/json',
        },
        body: {
            params: {},
            request: {
                pdfUrl: downloadUrl,
                expiry
            }
        },
        json: true
    }
    return requestPromise(options).then(apiResponse => {
        if (_.get(apiResponse, 'responseCode') === 'OK') {
            const signedUrl = _.get(apiResponse, 'result.signedUrl');
            callback(null, input, signedUrl, certificateId);
        }
    }).catch(err => {
        console.log('error while downloading certificate', _.get(err, 'message'))
        callback(true, null);
    })
}

const addCertificateApiCall = (input, generateCertApiResponse, callback) => {
    const apiResponseObj = _.get(generateCertApiResponse, 'result.response')[0];
    const endPoint = 'certreg/v1/certs/add';
    const options = {
        method: 'POST',
        url: `${_.get(envHelper, 'LEARNER_URL')}${endPoint}`,
        headers: {
            'Authorization': `Bearer ${_.get(envHelper, 'PORTAL_API_AUTH_TOKEN')}`,
            'Content-Type': 'application/json'
        },
        body: {
            params: {},
            request: certAddRequestBody(apiResponseObj)
        },
        json: true
    }
    return requestPromise(options).then(apiResponse => {
        if (_.get(apiResponse, 'responseCode') === 'OK' && _.get(apiResponse, 'result.id')) {
            const response = {
                downloadUrl: _.get(generateCertApiResponse, 'result.response[0].pdfUrl'),
                certificateId: _.get(apiResponseObj, 'id')
            }
            callback(null, input, response);
        }
    }).catch(err => {
        console.log('Error while adding certificate to registry', _.get(err, 'message'))
        callback(true, null);
    })
}


const generateCertificateApiCall = (input, callback) => {
    const endPoint = 'v1/certs/generate';
    const request = certGenerateRequestBody(input);
    const options = {
        method: 'POST',
        url: `${_.get(envHelper, 'LEARNER_URL')}cert/${endPoint}`,
        headers: {
            'Authorization': `Bearer ${_.get(envHelper, 'PORTAL_API_AUTH_TOKEN')}`,
            'Content-Type': 'application/json'
        },
        body: {
            params: {},
            request
        },
        json: true
    }
    return requestPromise(options).then(apiResponse => {
        if (_.get(apiResponse, 'responseCode') === 'OK' && _.get(apiResponse, 'result.response')) {
            callback(null, input, apiResponse);
        }
    }).catch(err => {
        console.log('Error while generating certificate', _.get(err, 'message'));
        callback(true, null)
    })
}

const validateRequestBody = (req, res, next) => {
    const file = _.get(req, 'file');
    const certType = _.get(req, 'body.cert-type');
    const userDetails = _.get(req, 'userDetails');
    var rspObj = { file, certType, userDetails };
    let err = [];
    if (!file) err.push('csv-file-missing');
    if (!userDetails) err.push('user-details-missing');
    if (!certType) err.push('cert-type-missing')
    if (!file || !certType) {
        res.status(404);
        const response = {
            responseCode: "CLIENT_ERROR",
            params: {
                err: "INVALID_REQUEST",
                status: "INVALID_REQUEST",
                errmsg: _.join(err, ', ')
            },
            result: {}
        }
        res.send(apiResponse(response))
    } else {
        req.rspObj = rspObj;
        next();
    }
}

const isCsvFile = (req, res, next) => {
    const file = _.get(req, 'rspObj.file');
    if (path.extname(_.get(file, 'originalname')) === '.csv' && _.get(file, 'mimetype') === 'text/csv') {
        next();
    } else {
        res.status(400)
        const response = {
            responseCode: "CLIENT_ERROR",
            params: {
                err: "INVALID_FILE_FORMAT",
                status: "INVALID_FILE_FORMAT",
                errmsg: "user upload failed due to invalid file format"
            },
            result: {}
        }
        res.send(apiResponse(response))
    }
}

const checkForErrors = () => {
    return function (req, res, next) {
        const fileDetails = _.get(req, 'rspObj.file');
        const csvObj = fs.readFileSync(path.join(_.get(fileDetails, 'path')), { encoding: 'utf8' });
        const jsonObj = convertCsvToJson(csvObj);
        const errors = checkForFileErrors(jsonObj);
        if (_.isEmpty(errors)) {
            req.rspObj.jsonObj = jsonObj;
            next();
        } else {
            res.status(400)
            const response = {
                responseCode: "CLIENT_ERROR",
                params: {
                    err: "CORRUPT_FILE",
                    status: "CORRUPT_FILE",
                    errmsg: _.join(errors, ',')
                },
                result: {}
            }
            res.send(apiResponse(response));
        }
    }
}

const checkForFileErrors = (jsonObj) => {
    if (jsonObj) {
        const err = [];
        _.each(jsonObj, function (value, key) {
            var isName = false;
            var error = ''
            for (var val in value) {
                if (val.toLowerCase() === 'name') {
                    isName = validateName(value[val]);
                }
            }
            if (!isName) {
                error = `Row ${(Number(key) + 1)} : Name is Empty`
            }
            if (error) {
                err.push(error);
            }
        });
        return err;
    } else {
        return [];
    }
}

const apiResponse = ({ responseCode, result, params: { err, errmsg, status } }) => {
    return {
        'id': 'api.user.upload',
        'ver': '1.0',
        'ts': dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss:lo'),
        'params': {
            'resmsgid': uuidv1(),
            'msgid': null,
            'status': status,
            'err': err,
            'errmsg': errmsg
        },
        'responseCode': responseCode,
        'result': result
    }
}

const insertCsvIntoDB = () => {
    return (req, res, next) => {
        const rspObj = _.get(req, 'rspObj');
        const data = {
            createdby: "ravinder kumar",
            createdon: new Date(),
            data: JSON.stringify(_.get(rspObj, 'jsonObj')),
            failureresult: "",
            lastupdatedon: new Date(),
            objecttype: "certificate",
            organisationid: "ORG_001",
            processendtime: _.toString(new Date()),
            processstarttime: _.toString(new Date()),
            retrycount: 0,
            status: 0,
            storagedetails: "",
            successresult: "",
            uploadedby: "ravinder kumar",
            uploadeddate: _.toString(new Date())
        }
        cassandraUtil.insertData(data, (err, result) => {
            if (err && !result) {
                console.log('Error occured while saving to DB', err);
                res.status(500)
                const response = {
                    responseCode: "SERVER_ERROR",
                    params: {
                        err: "SERVER_ERROR",
                        status: "SERVER_ERROR",
                        errmsg: 'Error occured while saving to DB'
                    },
                    result: {}
                }
                res.send(apiResponse(response));
            } else {
                rspObj['processId'] = result;
                req.rspObj = rspObj;
                res.send({
                    processId: result
                })
                next();
            }
        })
    }
}

module.exports = {
    isCsvFile,
    checkForErrors,
    insertCsvIntoDB,
    generateAndAddCertificates,
    validateRequestBody
}