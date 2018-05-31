import { UserService } from './../user/user.service';
import { IPageSection } from './../../interfaces/index';
import { Injectable } from '@angular/core';
import { ConfigService } from '@sunbird/shared';
import { LearnerService } from './../learner/learner.service';
import { Observable } from 'rxjs/Observable';
/**
*  Service for page API calls.
*/
@Injectable()
export class PageApiService {
  /**
  *  To do learner service api call.
  */
  private learnerService: LearnerService;
   /**
   *  To get url, app configs.
   */
  private config: ConfigService;
  /**
  * the "constructor"
  *
  * @param {LearnerService} learnerService Reference of LearnerService.
  * @param {ConfigService} config Reference of ConfigService
  */
  constructor(config: ConfigService, learnerService: LearnerService, public userService: UserService) {
    this.config = config;
    this.learnerService = learnerService;
  }
  /**
   *  api call for get page data.
   */
  getPageData(requestParam: IPageSection) {
    const option: any = {
      url: this.config.urlConFig.URLS.PAGE_PREFIX,
      data: {
        request: {
          source: requestParam.source,
          name: requestParam.name,
          filters: requestParam.filters,
          sort_by: requestParam.sort_by,
        }
      }
    };
    if (this.userService.contentChannelFilter) {
      option.data.request.filters.channel = this.userService.contentChannelFilter;
    }
    return this.learnerService.post(option);
  }
}


