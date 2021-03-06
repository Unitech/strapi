'use strict';

/**
 * Module dependencies
 */

// Node.js core.
const cluster = require('cluster');

// Public node modules.
const _ = require('lodash');

// Local utilities.
const responsesPolicy = require('../../core/responses/policy');

// Strapi utilities.
const finder = require('strapi-utils').finder;
const joijson = require('strapi-utils').joijson;
const regex = require('strapi-utils').regex;

/**
 * Router hook
 */

module.exports = strapi => {
  return {

    /**
     * Default options
     */

    defaults: {
      prefix: '',
      routes: {}
    },

    /**
     * Initialize the hook
     */

    initialize: cb => {
      const Joi = strapi.middlewares.joiRouter.Joi;
      const builder = joijson.builder(Joi);

      if (((cluster.isWorker && strapi.config.reload.workers > 0) || (cluster.isMaster && strapi.config.reload.workers < 1)) || (!strapi.config.reload && cluster.isMaster)) {
        // Initialize the router.
        if (!strapi.router) {
          strapi.router = strapi.middlewares.joiRouter();
          strapi.router.prefix(strapi.config.prefix);
        }

        // Add response policy to the global variable.
        _.set(strapi.policies, 'responsesPolicy', responsesPolicy);
        // Parse each route from the user config, load policies if any
        // and match the controller and action to the desired endpoint.

        _.forEach(strapi.config.routes, value => {
          if (_.isEmpty(_.get(value, 'method')) || _.isEmpty(_.get(value, 'path'))) {
            return;
          }

          const endpoint = `${value.method} ${value.path}`;

          try {
            const {route, policies, action, validate} = routerChecker(value, endpoint);

            if (_.isUndefined(action) || !_.isFunction(action)) {
              return strapi.log.warn('Ignored attempt to bind route `' + endpoint + '` to unknown controller/action.');
            }

            strapi.router.route(_.omitBy({
              method: value.method,
              path: value.path,
              handler: [strapi.middlewares.compose(policies), action],
              validate: validate
            }, _.isEmpty));
          } catch (err) {
            cb(err);
          }
        });

        // Parse each plugin's routes.
        _.forEach(strapi.config.plugins.routes, (value, plugin) => {
          // Create router for each plugin.
          // Prefix router with the plugin's name.
          const router = strapi.middlewares.joiRouter();

          // Exclude routes with prefix.
          const excludedRoutes = _.omitBy(value, o => !o.hasOwnProperty('prefix'));

          // Add others routes to the plugin's router.
          _.forEach(_.omit(value, _.keys(excludedRoutes)), value => {
            if (_.isEmpty(_.get(value, 'method')) || _.isEmpty(_.get(value, 'path'))) {
              return;
            }

            const endpoint = `${value.method} ${value.path}`;

            try {
              const {route, policies, action, validate} = routerChecker(value, endpoint, plugin);

              if (_.isUndefined(action) || !_.isFunction(action)) {
                return strapi.log.warn('Ignored attempt to bind route `' + endpoint + '` to unknown controller/action.');
              }

              router.route(_.omitBy({
                method: value.method,
                path: value.path,
                handler: _.remove([strapi.middlewares.compose(policies), action], o => _.isFunction(o)),
                validate: validate
              }, _.isEmpty));
            } catch (err) {
              cb(err);
            }
          });

          router.prefix('/' + plugin);

          // /!\ Could override main router's routes.
          if (!_.isEmpty(excludedRoutes)) {
            _.forEach(excludedRoutes, value => {
              if (_.isEmpty(_.get(value, 'method')) || _.isEmpty(_.get(value, 'path'))) {
                return;
              }

              const endpoint = `${value.method} ${value.path}`;

              try {
                const {route, policies, action, validate} = routerChecker(value, endpoint, plugin);

                if (_.isUndefined(action) || !_.isFunction(action)) {
                  return strapi.log.warn('Ignored attempt to bind route `' + endpoint + '` to unknown controller/action.');
                }

                strapi.router.route(_.omitBy({
                  method: value.method,
                  path: value.path,
                  handler: _.remove([strapi.middlewares.compose(policies), action], o => _.isFunction(o)),
                  validate: validate
                }, _.isEmpty));
              } catch (err) {
                cb(err);
              }
            });
          }

          // Mount plugin router on Strapi router
          strapi.router.use(router.middleware());
        });

        // Let the router use our routes and allowed methods.
        strapi.app.use(strapi.router.middleware());
        strapi.app.use(strapi.router.router.allowedMethods());

        // Handle router errors.
        strapi.app.use(function * (next) {
          try {
            yield next;

            const status = this.status || 404;

            if (status === 404) {
              this.throw(404);
            }
          } catch (err) {
            err.status = err.status || 500;
            err.message = err.expose ? err.message : 'Houston, we have a problem.';

            this.status = err.status;
            this.body = {
              code: err.status,
              message: err.message
            };

            this.app.emit('error', err, this);
          }
        });
      }

      cb();

      // Middleware used for every routes.
      // Expose the endpoint in `this`.
      function globalPolicy(endpoint, value, route) {
        return function * (next) {
          this.request.route = {
            endpoint: _.trim(endpoint),
            controller: _.trim(value.controller),
            action: _.trim(value.action),
            splittedEndpoint: _.trim(route.endpoint),
            verb: route.verb && _.trim(route.verb.toLowerCase())
          };
          yield next;
        };
      }

      function routerChecker(value, endpoint, plugin) {
        const route = regex.detectRoute(endpoint);

        // Define controller and action names.
        const handler = _.trim(value.handler).split('.');
        const controller = strapi.controllers[handler[0].toLowerCase()] || strapi.plugins[plugin].controllers[handler[0].toLowerCase()];
        const action = controller[handler[1]];

        // Retrieve the API's name where the controller is located
        // to access to the right validators
        const currentApiName = finder(strapi.api, controller);

        // Init policies array.
        const policies = [];
        // Add the `globalPolicy`.
        policies.push(globalPolicy(endpoint, value, route));

        // Add the `responsesPolicy`.
        policies.push(responsesPolicy);

        // Allow string instead of array of policies
        if (!_.isArray(_.get(value, 'config.policies')) && !_.isEmpty(_.get(value, 'config.policies'))) {
          value.config.policies = [value.config.policies];
        }

        if (_.isArray(_.get(value, 'config.policies')) && !_.isEmpty(_.get(value, 'config.policies'))) {
          _.forEach(value.config.policies, policy => {
            // Looking for global policy or namespaced
            if (_.startsWith(policy, '*', 0) && !_.isEmpty(_.get(strapi.policies, policy.substring(1).toLowerCase()))) {
              return policies.push(strapi.policies[policy.substring(1).toLowerCase()]);
            } else if (!_.startsWith(policy, '*', 0) && !_.isEmpty(_.get(strapi.api, currentApiName + '.policies.' + policy.toLowerCase()))) {
              return policies.push(strapi.api[currentApiName].policies[policy.toLowerCase()]);
            }

            strapi.log.error('Ignored attempt to bind route `' + endpoint + '` with unknown policy `' + policy + '`.');
          });
        }

        // Init validate
        const validate = {};

        if (_.isString(_.get(value, 'config.validate')) && !_.isEmpty(_.get(value, 'config.validate'))) {
          const validator = _.get(strapi.api, currentApiName + '.validators.' + value.config.validate);

          _.merge(validate, _.mapValues(validator, value => {
            return builder.build(value);
          }));
        }

        return {
          route: route,
          policies: policies,
          action: action,
          validate: validate
        };
      }
    }
  };
};
