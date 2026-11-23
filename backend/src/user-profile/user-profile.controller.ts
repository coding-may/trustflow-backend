import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { ZodError } from 'zod';
import { UserProfileService } from './user-profile.service';
import {
  CreateUserProfileDto,
  UpdateUserProfileDto,
  RateUserDto,
  CreateUserProfileSchema,
  UpdateUserProfileSchema,
  RateUserSchema,
  SearchQuerySchema,
} from './user-profile.dto';
import { UserType, UserStatus } from './user-profile.entity';
import { JwtAuthGuard } from '../auth/auth.guard';
import { S3StorageService } from './s3-storage.service';
import { sniffImageMime } from './image-signature.util';
import {
  toOwnerProfile,
  toProfileForViewer,
  toPublicProfile,
  toPublicProfilePage,
} from './user-profile.mapper';
import { OWNER_PROFILE_SCHEMA, PUBLIC_PROFILE_SCHEMA } from './user-profile.swagger';
import {
  calculateProfileCompleteness,
  getProfileCompletenessBreakdown,
} from './profile-completeness.util';

/**
 * Shape of `req.user` once `JwtAuthGuard` has run — see
 * `JwtStrategy.validate()` (src/auth/jwt.strategy.ts).
 */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

@ApiTags('User Profiles')
@Controller('profiles')
export class UserProfileController {
  constructor(
    private readonly userProfileService: UserProfileService,
    private readonly s3StorageService: S3StorageService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a new user profile',
    description:
      'Creates a new user profile for a freelancer or client. Requires authentication; ' +
      '`walletAddress` must match the wallet address on the authenticated JWT — you can only ' +
      'create a profile for the wallet you signed in with, not on behalf of another address.',
  })
  @ApiBody({
    description: 'User profile creation details',
    schema: {
      type: 'object',
      required: ['walletAddress', 'name', 'userType'],
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Stellar wallet address (G-prefixed, 56 characters)',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        name: {
          type: 'string',
          description: 'User display name',
          example: 'John Doe',
          minLength: 2,
          maxLength: 100,
        },
        bio: {
          type: 'string',
          description: 'User biography',
          example: 'Experienced blockchain developer with 5+ years in Web3',
          maxLength: 500,
        },
        userType: {
          type: 'string',
          enum: ['freelancer', 'client', 'both'],
          description: 'Type of user account',
          example: 'freelancer',
        },
        avatarUrl: {
          type: 'string',
          description: 'Profile image URL',
          example: 'https://example.com/avatar.jpg',
        },
        email: {
          type: 'string',
          description: 'Email address (optional)',
          example: 'john@example.com',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of skills (for freelancers)',
          example: ['Solidity', 'Rust', 'TypeScript', 'Smart Contracts'],
          maxItems: 20,
        },
        socialLinks: {
          type: 'object',
          properties: {
            twitter: { type: 'string', example: 'https://twitter.com/johndoe' },
            github: { type: 'string', example: 'https://github.com/johndoe' },
            linkedin: { type: 'string', example: 'https://linkedin.com/in/johndoe' },
            website: { type: 'string', example: 'https://johndoe.dev' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Profile created successfully',
    schema: OWNER_PROFILE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'walletAddress does not match the authenticated wallet',
  })
  @ApiResponse({ status: 409, description: 'Profile with this wallet address already exists' })
  async create(@Body() dto: CreateUserProfileDto, @Req() req: AuthenticatedRequest) {
    const validated = CreateUserProfileSchema.parse(dto);

    // The caller can only ever prove ownership of the wallet address on
    // their own JWT — trusting walletAddress straight from the body would
    // let anyone squat on someone else's real address before its owner
    // ever registers (see #205).
    if (validated.walletAddress !== req.user.address) {
      throw new ForbiddenException('walletAddress must match the authenticated wallet address');
    }

    // The caller is the owner (checked above), so their own email is included.
    return toOwnerProfile(await this.userProfileService.create(validated));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get my own profile',
    description:
      'Returns the profile of the authenticated wallet, including the email address it was ' +
      'registered with. This is the only read endpoint that returns an email address.',
  })
  @ApiResponse({
    status: 200,
    description: 'Your profile, including your email address',
    schema: OWNER_PROFILE_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'The authenticated wallet has no profile yet' })
  async findMine(@Req() req: AuthenticatedRequest) {
    return toOwnerProfile(await this.userProfileService.findByWalletAddress(req.user.address));
  }

  @Get('me/completeness')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get my profile completeness percentage',
    description:
      'Returns the completeness percentage (0-100) of the authenticated user profile based on ' +
      'weighted field completion. Use the breakdown endpoint for detailed field-by-field analysis.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile completeness percentage',
    schema: {
      type: 'object',
      properties: {
        completeness: {
          type: 'number',
          description: 'Completeness percentage (0-100)',
          example: 65,
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async getMyCompleteness(@Req() req: AuthenticatedRequest) {
    const profile = await this.userProfileService.findByWalletAddress(req.user.address);
    return { completeness: calculateProfileCompleteness(profile) };
  }

  @Get('me/completeness/breakdown')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get detailed profile completeness breakdown',
    description:
      'Returns a detailed breakdown of profile completeness by field, showing which fields are ' +
      'completed, their weights, and individual contributions to the total score. Useful for ' +
      'guiding users on how to improve their profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Detailed completeness breakdown',
    schema: {
      type: 'object',
      properties: {
        totalCompleteness: {
          type: 'number',
          description: 'Overall completeness percentage',
          example: 65,
        },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fieldName: { type: 'string', example: 'bio' },
              weight: { type: 'number', example: 15 },
              completed: { type: 'boolean', example: true },
              contribution: { type: 'number', example: 15 },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async getMyCompletenessBreakdown(@Req() req: AuthenticatedRequest) {
    const profile = await this.userProfileService.findByWalletAddress(req.user.address);
    return getProfileCompletenessBreakdown(profile);
  }

  @Get(':id/completeness')
  @ApiOperation({
    summary: 'Get profile completeness percentage by ID',
    description:
      'Returns the completeness percentage (0-100) of any user profile. This is a public endpoint.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile completeness percentage',
    schema: {
      type: 'object',
      properties: {
        completeness: {
          type: 'number',
          description: 'Completeness percentage (0-100)',
          example: 85,
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async getProfileCompleteness(@Param('id') id: string) {
    const profile = await this.userProfileService.findById(id);
    return { completeness: calculateProfileCompleteness(profile) };
  }

  @Get()
  @ApiOperation({
    summary: 'Get all user profiles',
    description:
      'Retrieves all user profiles with optional filtering and pagination. ' +
      'Email addresses are never included.',
  })
  @ApiQuery({
    name: 'userType',
    required: false,
    enum: UserType,
    description: 'Filter by user type',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: UserStatus,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'minRating',
    required: false,
    type: Number,
    description: 'Minimum rating filter',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of user profiles',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              walletAddress: { type: 'string' },
              name: { type: 'string' },
              userType: { type: 'string' },
              rating: { type: 'number' },
              completedJobs: { type: 'number' },
              isVerified: { type: 'boolean' },
            },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  async findAll(
    @Query('userType') userType?: UserType,
    @Query('status') status?: UserStatus,
    @Query('minRating') minRating?: number,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    const page = await this.userProfileService.findAll({
      userType,
      status,
      minRating: minRating ? parseFloat(minRating.toString()) : undefined,
      offset: safeOffset,
      limit: safeLimit,
    });
    return toPublicProfilePage(page);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search user profiles',
    description:
      'Search profiles by name, bio, or skills. Results are ranked by relevance. ' +
      'Email addresses are never included.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    description: 'Search query (2-100 characters)',
    example: 'blockchain developer',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated search results ranked by relevance',
  })
  @ApiResponse({ status: 400, description: 'q is missing, blank, or out of range' })
  async search(
    @Query('q') query: string | undefined,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    let validated: { q: string };
    try {
      validated = SearchQuerySchema.parse({ q: query });
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid search query');
      }
      throw err;
    }

    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    const page = await this.userProfileService.search(validated.q, {
      offset: safeOffset,
      limit: safeLimit,
    });
    return toPublicProfilePage(page);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get profile by ID',
    description:
      'Retrieves a user profile by its unique ID. The email address is never included; ' +
      'owners read theirs from `GET /profiles/me`.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile details',
    schema: PUBLIC_PROFILE_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async findById(@Param('id') id: string) {
    return toPublicProfile(await this.userProfileService.findById(id));
  }

  @Get('wallet/:address')
  @ApiOperation({
    summary: 'Get profile by wallet address',
    description:
      'Retrieves a user profile by their Stellar wallet address. The email address is never ' +
      'included; owners read theirs from `GET /profiles/me`.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar wallet address',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile details',
    schema: PUBLIC_PROFILE_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async findByWalletAddress(@Param('address') address: string) {
    return toPublicProfile(await this.userProfileService.findByWalletAddress(address));
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update user profile',
    description: 'Updates an existing user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiBody({
    description: 'Profile update fields',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 100 },
        bio: { type: 'string', maxLength: 500 },
        userType: { type: 'string', enum: ['freelancer', 'client', 'both'] },
        avatarUrl: { type: 'string' },
        email: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
        socialLinks: { type: 'object' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Profile updated successfully. The email address is only included when the caller ' +
      'owns the profile.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'You can only update your own profile' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserProfileDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const validated = UpdateUserProfileSchema.parse(dto);
    return toProfileForViewer(
      await this.userProfileService.update(id, validated),
      req.user.address,
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete user profile',
    description: 'Deletes a user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Profile deleted successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'You can only delete your own profile' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async delete(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const profile = await this.userProfileService.findById(id);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    if (profile.walletAddress !== req.user.address) {
      throw new ForbiddenException('You can only delete your own profile');
    }

    await this.userProfileService.delete(id);
  }

  @Post(':id/rate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Rate a user',
    description: 'Submit a rating for a user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID to rate',
  })
  @ApiBody({
    description: 'Rating details',
    schema: {
      type: 'object',
      required: ['walletAddress', 'rating'],
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Wallet address of the rater',
        },
        rating: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Rating value (1-5)',
          example: 5,
        },
        review: {
          type: 'string',
          maxLength: 1000,
          description: 'Optional review text',
          example: 'Excellent work, delivered on time!',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Rating submitted successfully. The email address is only included when the caller ' +
      'owns the profile.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async rateUser(
    @Param('id') id: string,
    @Body() dto: RateUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const validated = RateUserSchema.parse(dto);
    return toProfileForViewer(
      await this.userProfileService.rateUser(id, validated),
      req.user.address,
    );
  }

  @Post(':id/verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Verify a user profile',
    description: 'Marks a user profile as verified. Admin only.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiResponse({
    status: 200,
    description:
      'Profile verified successfully. The email address is only included when the caller ' +
      'owns the profile.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verifyUser(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return toProfileForViewer(await this.userProfileService.verifyUser(id), req.user.address);
  }

  @Post(':id/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Upload avatar image',
    description:
      'Uploads a profile picture to S3-compatible storage and updates the user profile. ' +
      'Accepts JPEG, PNG, or WebP images up to 5MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Avatar image file (JPEG, PNG, or WebP, max 5MB)',
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Profile ID' })
  @ApiResponse({ status: 200, description: 'Avatar uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'You can only upload an avatar for your own profile' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ) {
    const profile = await this.userProfileService.findById(id);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    if (profile.walletAddress !== req.user.address) {
      throw new ForbiddenException('You can only upload an avatar for your own profile');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, and WebP images are allowed');
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size must not exceed 5MB');
    }

    // #981: file.mimetype and the filename extension are both supplied by the client and
    // trivially spoofable — sniff the actual bytes before trusting this is really an image.
    const sniffedMime = sniffImageMime(file.buffer);
    if (!sniffedMime) {
      throw new BadRequestException('File content is not a valid JPEG, PNG, or WebP image');
    }

    const result = await this.s3StorageService.uploadAvatar(
      file.buffer,
      file.originalname,
      sniffedMime,
    );

    await this.userProfileService.update(id, { avatarUrl: result.url });

    return { avatarUrl: result.url, key: result.key };
  }
}
